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
  filesTouched: ["index.html"],
  commandsRun: 1,
  permissionDenials: 2,
  resumable: false,
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

  it("hands a bare task to the device, whose default-folder fallback owns it", async () => {
    // No client-side "needs a place to work" guard any more: the route falls
    // back to the owner's stored default folder, and when none is stored it
    // answers 400 with its own sentence — which must reach the model intact.
    apiPost.mockRejectedValue(new ApiError(400, JSON.stringify({ error: "Give a code project id or a folder to work in.", kind: "invalid" })));
    const out = await harness().call("coding_agent_run", { task: "do something" });
    expect(apiPost).toHaveBeenCalledWith(
      "/setup-api/coding-agent/run",
      { task: "do something" },
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.message).toMatch(/code project id or a folder/);
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

  it("does not send a provider/model refusal off to change the working folder", async () => {
    // A model named with no provider is resolved against the OWNER's default,
    // which this process cannot read, so the pair can only be refused at the
    // route — as a 400 with the same `kind: "invalid"` a bad folder answers.
    // Told to "pass a project_id instead", the caller changed a folder that was
    // never the problem. The route's `code` is what tells the two apart.
    apiPost.mockRejectedValue(new ApiError(400, JSON.stringify({
      error: "ClawBox AI chooses its own model; name a model only with the \"anthropic\" provider.",
      kind: "invalid",
      code: "provider",
    })));
    const out = await harness().call("coding_agent_run", { task: "x", project_id: "site", model: "claude-opus-5" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.message).toMatch(/chooses its own model/);
    expect(out.error.next).toMatch(/working folder was not the problem/i);
    expect(out.error.next).not.toMatch(/code_project_list|code_project_init/);
  });

  it("keeps the folder advice for a 400 from a device that sends no code", async () => {
    // An older ClawBox answers the folder rules with `kind: "invalid"` alone.
    // Absent a code, the advice must stay exactly what it has always been.
    apiPost.mockRejectedValue(new ApiError(400, JSON.stringify({
      error: "That folder holds credentials.",
      kind: "invalid",
    })));
    const out = await harness().call("coding_agent_run", { task: "x", directory: "/home/clawbox/clawbox/data" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.next).toMatch(/code_project_list/);
    expect(out.error.next).not.toMatch(/working folder was not the problem/i);
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

  it("describes a draft as not started, never with a duration", async () => {
    // elapsed() on a draft would measure time since drafting — "draft after
    // 17h 45m" told the assistant a run had been going for hours.
    apiGet.mockResolvedValue({ run: { ...RUN, status: "draft", completedAt: undefined } });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/^Run run-k3x9q2ab: draft \(not started\)/);
    expect(out.text).not.toMatch(/draft after/);
  });

  it("names the run an automatic review pass belongs to, in the description and the listing", async () => {
    // A review pass's task text is the harness's fixed brief, so without this
    // line the assistant could not tell which run it reviewed once the
    // progress tail had cut the only other mention.
    const review = { ...RUN, id: "run-review01", task: "Automatic review pass. Adversarially review…", reviewOf: RUN.id };
    apiGet.mockResolvedValue({ run: review });
    const one = await harness().call("coding_agent_status", { run_id: "run-review01" });
    expect(one.isError).toBe(false);
    if (one.isError) return;
    expect(one.text).toContain(`Automatic review pass of ${RUN.id}`);

    apiGet.mockResolvedValue({ runs: [review, RUN] });
    const list = await harness().call("coding_agent_status", {});
    expect(list.isError).toBe(false);
    if (list.isError) return;
    const rows = JSON.parse(list.text) as { run_id: string; review_of?: string }[];
    expect(rows[0].review_of).toBe(RUN.id);
    expect(rows[1].review_of).toBeUndefined();
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
    apiGet.mockResolvedValue({ run: { ...RUN, progress, summary, error: "something went wrong", workflowTelemetry: { childrenTotal: 300, childrenActive: 0, complete: true, workflows: Array.from({ length: 100 }, (_, i) => ({ id: `wf_${i}_${"x".repeat(220)}`, peakActive: 3 })) } } });

    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab", tail: 60 });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text.length).toBeGreaterThan(STATUS_OUTPUT_CHARS); // the cap really would bite

    const capped = capText(out.text, STATUS_OUTPUT_CHARS);
    expect(capped).toContain("THE-SUMMARY-STARTS-HERE");
    expect(capped).toContain("THE-SUMMARY-ENDS-HERE");
    expect(capped).toContain("and 90 more workflows not listed");
    expect(capped).toContain("[error]\nsomething went wrong");
    // The activity log is the long, low-value part, so it is what the cut eats.
    expect(capped).toContain("…[truncated");
    expect(capped.indexOf("[summary from the coding agent")).toBeLessThan(capped.indexOf("[recent activity]"));
  });

  it("tells the agent to go back to the user rather than sit on a running run", async () => {
    // The assistant used to block the whole conversation waiting for a run,
    // so the owner could not ask it anything until it returned.
    apiGet.mockResolvedValue({ run: { ...RUN, status: "running", completedAt: null, summary: null } });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/Still working/);
    expect(out.text).toMatch(/do not sit here polling/i);
    expect(out.text).toMatch(/available for other questions/i);
  });

  it("never tells the agent to resume a run a resume cannot fix", async () => {
    // This advice is what turned one transient upstream failure into a project
    // that failed forever: the agent resumed the poisoned session and
    // re-enacted the same authentication error.
    apiGet.mockResolvedValue({ run: { ...RUN, status: "failed", resumable: false, error: "Failed to authenticate." } });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/Do not resume this one/);
    expect(out.text).not.toMatch(/resume_run_id/);
  });

  it("does offer a resume when the run merely hit a ceiling", async () => {
    apiGet.mockResolvedValue({ run: { ...RUN, status: "failed", resumable: true, error: "Stopped after 60 turns." } });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/resume_run_id/);
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
    expect(apiPost).toHaveBeenCalledWith("/setup-api/coding-agent/stop", { runId: "run-k3x9q2ab" }, expect.anything());
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

/**
 * WHICH ACCOUNT PAYS. `coding_agent_run` can name one per run, and the pair
 * is checked HERE as well as at the route — the enum in the schema cannot
 * express "this model belongs to one provider and not the other", and a
 * round trip to be told so is a step a small model spends arguing with.
 *
 * The rule that costs the most to get wrong is the last one: an OMITTED
 * provider must stay omitted. This process does not know the owner's stored
 * default, so sending its own idea of one would quietly move a run to another
 * account.
 */
describe("coding_agent_run — provider and model", () => {
  it("offers both as closed sets, not free text", () => {
    const shape = harness().get("coding_agent_run").shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(shape.provider.safeParse("anthropic").success).toBe(true);
    expect(shape.provider.safeParse("clawbox-ai").success).toBe(true);
    expect(shape.provider.safeParse("openai").success).toBe(false);
    expect(shape.model.safeParse("claude-opus-5").success).toBe(true);
    expect(shape.model.safeParse("gpt-5").success).toBe(false);
    // Both optional: omitting them means the owner's default.
    expect(shape.provider.safeParse(undefined).success).toBe(true);
    expect(shape.model.safeParse(undefined).success).toBe(true);
  });

  it("sends only what the caller actually named", async () => {
    apiPost.mockResolvedValue({ started: true, run: RUN });
    await harness().call("coding_agent_run", { task: "Do the thing", project_id: "site" });
    expect(apiPost.mock.calls[0][1]).toEqual({ task: "Do the thing", projectId: "site" });
  });

  it("passes a named provider and model to the device", async () => {
    apiPost.mockResolvedValue({ started: true, run: RUN });
    await harness().call("coding_agent_run", { task: "t", project_id: "site", provider: "anthropic", model: "claude-sonnet-5" });
    expect(apiPost.mock.calls[0][1]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("lets a model-only request through — the owner's default decides, not this process", async () => {
    // This process does not know the owner's stored default. Checked against
    // the shipped one, `{ model: "claude-opus-5" }` on a box whose default is
    // already `anthropic` was refused — and the refusal told the agent to pass
    // the very provider that was in force.
    apiPost.mockResolvedValue({ started: true, run: RUN });
    const out = await harness().call("coding_agent_run", { task: "t", project_id: "site", model: "claude-opus-5" });
    expect(out.isError).toBe(false);
    expect(apiPost.mock.calls[0][1]).toEqual({ task: "t", projectId: "site", model: "claude-opus-5" });
  });

  it("refuses a model named for ClawBox AI without calling the device", async () => {
    const out = await harness().call("coding_agent_run", { task: "t", project_id: "site", provider: "clawbox-ai", model: "claude-opus-5" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.message).toMatch(/cannot be named/);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("says which account a run was on when it was not the box's own plan", async () => {
    apiGet.mockResolvedValue({ run: { ...RUN, provider: "anthropic", requestedModel: "claude-opus-5", model: "claude-opus-5" } });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/owner's anthropic account/i);
  });

  it("says nothing about the account for an ordinary ClawBox AI run", async () => {
    apiGet.mockResolvedValue({ run: { ...RUN, provider: "clawbox-ai" } });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toMatch(/account/i);
  });

  it("names both halves when the device says the harness is not ready", async () => {
    // With two providers, "Claude Code or ClawBox AI is missing" is wrong
    // whenever the run was to be paid from the owner's own account.
    apiPost.mockRejectedValue(new ApiError(409, JSON.stringify({ error: "not connected", kind: "not_ready" })));
    const out = await harness().call("coding_agent_run", { task: "t", project_id: "site" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/the account the run would be paid from/);
  });
});

/**
 * The deliverable, as the agent can set it and read it back.
 *
 * Two things matter on this surface. The LIST shape: the schema rules here
 * forbid array and JSON-in-a-string parameters (both harnesses rewrite them
 * differently on the way in), so the tool takes a comma-separated string and
 * the DEVICE does the validating — a tool that judged paths itself would be a
 * second opinion beside the route's. And the `gave_up` advice: that ending is
 * the whole point of the feature, and the worst possible thing to say about it
 * is "start a fresh run", which would throw away a session that still holds
 * every bit of the work.
 */
describe("the deliverable", () => {
  it("turns the comma-separated list into the device's own shape", async () => {
    apiPost.mockResolvedValue({ started: true, run: { ...RUN, status: "running" } });
    const out = await harness().call("coding_agent_run", {
      task: "build the app", project_id: "site", deliverable_files: " src/app.js , index.html ,, ",
    });
    expect(out.isError).toBe(false);
    expect(apiPost).toHaveBeenCalledWith(
      "/setup-api/coding-agent/run",
      { task: "build the app", projectId: "site", deliverable: { kind: "paths", paths: ["src/app.js", "index.html"] } },
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
    // The assistant is told the bar, so it can relay it rather than promising
    // the user a finish the box has not agreed to yet.
    if (out.isError) return;
    expect(out.text).toContain("src/app.js, index.html");
  });

  it("sends no deliverable when the caller named no files", async () => {
    apiPost.mockResolvedValue({ started: true, run: { ...RUN, status: "running" } });
    await harness().call("coding_agent_run", { task: "x", project_id: "site", deliverable_files: "  ,, " });
    expect(apiPost).toHaveBeenCalledWith(
      "/setup-api/coding-agent/run",
      { task: "x", projectId: "site" },
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
  });

  it("offers the agent no command deliverable at all", async () => {
    // Not merely refused by the device: absent from the schema. A parameter that
    // always answered "only the owner" is a refusal a small model argues with,
    // and on Hermes a candidate for the circuit breaker.
    const params = Object.keys(harness().get("coding_agent_run").shape);
    expect(params).toContain("deliverable_files");
    expect(params.some((p) => p.includes("command"))).toBe(false);
  });

  it("reports the bar and the verdict on a run that got there", async () => {
    apiGet.mockResolvedValue({
      run: {
        ...RUN,
        deliverable: { kind: "paths", paths: ["app.js"] },
        deliverableCheck: { ok: true, missing: null, checkedAt: Date.now() },
        attempts: [{ startedAt: 1, endedAt: 2, reason: null }],
        completionAttempts: 3,
      },
    });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("[deliverable]");
    expect(out.text).toContain("the file app.js");
    expect(out.text).toMatch(/which is why this counts as finished/);
  });

  it("says what is missing on a run that gave up, and NOT to start a fresh one", async () => {
    apiGet.mockResolvedValue({
      run: {
        ...RUN,
        status: "gave_up",
        resumable: true,
        deliverable: { kind: "paths", paths: ["app.js"] },
        deliverableCheck: { ok: false, missing: "app.js was not created.", checkedAt: Date.now() },
        attempts: [{ startedAt: 1, endedAt: 2, reason: "app.js was not created." }, { startedAt: 3, endedAt: 4, reason: "app.js was not created." }, { startedAt: 5, endedAt: 6, reason: "app.js was not created." }],
        completionAttempts: 3,
      },
    });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("app.js was not created.");
    expect(out.text).toContain("after 3 of 3 attempts");
    // The advice that matters: the session holds the work, so Resume is the way
    // on and a fresh run would start the task over.
    expect(out.text).toMatch(/Do NOT start a fresh run/);
    expect(out.text).toMatch(/Resume/);
    // And none of the other endings' advice has claimed it.
    expect(out.text).not.toMatch(/Relay the summary to the user/);
  });

  it("claims nothing about a record that carries no deliverable", async () => {
    apiGet.mockResolvedValue({ run: RUN });
    const out = await harness().call("coding_agent_status", { run_id: "run-k3x9q2ab" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).not.toContain("[deliverable]");
  });
});
