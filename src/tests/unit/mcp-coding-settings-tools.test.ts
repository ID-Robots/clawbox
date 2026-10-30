/**
 * `coding_settings_get` / `coding_settings_set` (mcp/tools/coding-agent.ts):
 * the owner's coding-team preferences, read with the valid choices beside
 * each and changed any subset at a time, through
 * /setup-api/coding-agent/settings (src/lib/coding-settings-patch.ts).
 *
 * What the agent sees: one readable block with every value and its choices;
 * a body carrying ONLY the fields it named, `default`/`auto` mapped to the
 * panel's `auto`; the route's own sentence on a refused value; and a refusal
 * it must not retry — with the Settings page named — for the fields that are
 * the owner's alone.
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

import { z } from "zod";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerCodingAgentTools, settingsBodyFrom } from "../../../mcp/tools/coding-agent";
import { ApiError } from "../../../mcp/lib/errors";
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS, paramDescriptionViolations } from "../../../mcp/lib/register";
import { PARAM_NAME_RE } from "../../../mcp/lib/schema";
import { AGENT_SETTABLE_FIELDS } from "../../../src/lib/coding-settings-shape";

function harness(edition: "openclaw" | "hermes" = "openclaw") {
  const h = captureRegistrar(edition);
  registerCodingAgentTools(h.reg, { codingAgent: true });
  return h;
}

const SETTINGS = {
  effort: "xhigh",
  effortLevels: ["low", "xhigh", "max", "ultracode"],
  roleModels: {
    planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "auto" },
    worker: { provider: "auto", model: "auto", effort: "auto" },
    reviewer: { provider: "auto", model: "auto", effort: "auto" },
  },
  roleModelMap: {
    planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "xhigh", auto: false, ready: true, problems: [], relativeCost: 10 },
    worker: { provider: "clawbox-ai", model: null, effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: null },
    reviewer: { provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "xhigh", auto: true, ready: false, problems: ["ClawBox AI is not connected."], relativeCost: 1 },
  },
  roleModelTiers: ["standard", "economy"],
  roleEffortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"],
  connectedProviders: ["clawbox-ai", "anthropic"],
  providerModels: { "clawbox-ai": ["deepseek-v4-flash"], anthropic: ["claude-opus-5-5", "claude-sonnet-5"] },
  reviewPass: false,
  autoPr: true,
  autoMerge: false,
  prBodyIncludesTask: "summary",
  prBodyTaskModes: ["summary", "full-redacted", "none"],
  teamDynamic: false,
  maxParallelRuns: 2,
  minMaxParallelRuns: 1,
  maxMaxParallelRuns: 4,
  historyRetention: "standard",
  historyRetentionModes: ["standard", "everything"],
  generateMedia: true,
  gitAuthorName: null,
  gitAuthorEmail: null,
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockResolvedValue(SETTINGS);
  apiPost.mockImplementation(async (_path: string, body: Record<string, unknown>) => ({
    changed: Object.keys(body),
    transcripts: [],
    settings: SETTINGS,
  }));
});

describe("registration", () => {
  it("registers both on both editions behind the coding agent's switch, and keeps the description contract", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const h = harness(edition);
      const get = h.get("coding_settings_get");
      const set = h.get("coding_settings_set");
      expect(get.opts.readOnly).toBe(true);
      expect(set.opts.readOnly).toBe(false);
      for (const tool of [get, set]) {
        expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
        expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
        expect(paramDescriptionViolations({ name: tool.name, description: tool.description, shape: tool.shape, opts: tool.opts })).toEqual([]);
        for (const param of Object.keys(tool.shape)) expect(param).toMatch(PARAM_NAME_RE);
      }
      expect(Object.keys(get.shape)).toEqual([]);
    }
    const off = captureRegistrar("openclaw");
    registerCodingAgentTools(off.reg, { codingAgent: false });
    expect(off.has("coding_settings_get")).toBe(false);
    expect(off.has("coding_settings_set")).toBe(false);
  });

  it("offers one optional parameter per settable field, every one optional, and tells the assistant to confirm cost-bearing changes", () => {
    const set = harness().get("coding_settings_set");
    expect(Object.keys(set.shape).sort()).toEqual([
      "auto_merge", "auto_pr", "effort", "generate_media", "git_author_email", "git_author_name", "history_retention",
      "max_parallel_runs",
      "planner_effort", "planner_model", "planner_provider",
      "pr_body_includes_task", "review_pass",
      "reviewer_effort", "reviewer_model", "reviewer_provider",
      "team_dynamic",
      "worker_effort", "worker_model", "worker_provider",
    ]);
    // Every parameter optional: an empty call parses (the handler then refuses it).
    expect(z.object(set.shape).safeParse({}).success).toBe(true);
    expect(set.description).toMatch(/owner's preferences/);
    expect(set.description).toMatch(/confirm before changing effort, a model or runs at once/i);
    // The schema names the choices the route takes.
    expect(z.object(set.shape).safeParse({ effort: "medium" }).success).toBe(false);
    expect(z.object(set.shape).safeParse({ effort: "max", planner_provider: "default", worker_effort: "auto", history_retention: "everything" }).success).toBe(true);
    expect(z.object(set.shape).safeParse({ planner_provider: "nobody" }).success).toBe(false);
  });

  it("covers every field of the agent-settable set and nothing the owner keeps", () => {
    // The flat parameters map onto the seam's field list: the three role
    // halves are `roleModels`, everything else is one field each.
    const body = settingsBodyFrom({
      effort: "low", planner_provider: "anthropic", worker_model: "economy", reviewer_effort: "low",
      review_pass: true, auto_pr: true, auto_merge: true, pr_body_includes_task: "none", team_dynamic: true,
      max_parallel_runs: 1, history_retention: "everything", generate_media: false, git_author_name: "Box", git_author_email: "box@example.com",
    });
    expect(Object.keys(body).sort()).toEqual([...AGENT_SETTABLE_FIELDS].sort());
    for (const key of ["enabled", "defaultDirectory", "provider", "providers", "realBrowser", "allowRules", "setupComplete"]) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe("coding_settings_get", () => {
  it("answers one readable block: every value with its choices, each role's choice and what it runs on, and the words a role takes", async () => {
    const out = await harness().call("coding_settings_get", {});
    expect(out.isError).toBe(false);
    expect(apiGet).toHaveBeenCalledWith("/setup-api/coding-agent/settings", expect.objectContaining({ timeoutMs: 15_000 }));
    const text = (out as { text: string }).text;
    expect(text).toContain("effort: xhigh — choices: low, xhigh, max, ultracode");
    expect(text).toContain("planner: provider anthropic, model claude-sonnet-5, effort auto → runs on anthropic claude-sonnet-5 at xhigh");
    expect(text).toContain("worker: provider auto, model auto, effort auto → runs on clawbox-ai at xhigh");
    expect(text).toContain("reviewer: provider auto, model auto, effort auto → runs on clawbox-ai deepseek-v4-flash at xhigh (NOT READY: ClawBox AI is not connected.)");
    expect(text).toContain("review_pass: off · auto_pr: on · auto_merge: off · pr_body_includes_task: summary (summary, full-redacted, none)");
    expect(text).toContain("max_parallel_runs: 2 (1–4 on this box)");
    expect(text).toContain("history_retention: standard (standard, everything)");
    expect(text).toContain("git_author: not set");
    expect(text).toContain("provider: auto or a connected account (clawbox-ai, anthropic)");
    expect(text).toContain("clawbox-ai: deepseek-v4-flash; anthropic: claude-opus-5-5, claude-sonnet-5");
    expect(text).toContain("never runs above xhigh");
    expect(text).toContain("owner's, in the Coding Agent app's Settings");
  });

  it("shows a set commit identity", async () => {
    apiGet.mockResolvedValue({ ...SETTINGS, gitAuthorName: "Ada", gitAuthorEmail: "ada@example.com" });
    const text = (await harness().call("coding_settings_get", {}) as { text: string }).text;
    expect(text).toContain("git_author: Ada <ada@example.com>");
  });
});

describe("coding_settings_set", () => {
  it("posts only the fields given, with default/auto mapped to the panel's auto, and answers what changed plus the final values", async () => {
    const out = await harness().call("coding_settings_set", {
      effort: "max",
      planner_provider: "anthropic",
      planner_model: "claude-sonnet-5",
      worker_effort: "default",
      reviewer_model: "AUTO",
      review_pass: true,
      max_parallel_runs: 3,
    });
    expect(out.isError).toBe(false);
    expect(apiPost).toHaveBeenCalledTimes(1);
    const [path, body, opts] = apiPost.mock.calls[0] as [string, unknown, { timeoutMs: number }];
    expect(path).toBe("/setup-api/coding-agent/settings");
    expect(body).toEqual({
      effort: "max",
      roleModels: {
        planner: { provider: "anthropic", model: "claude-sonnet-5" },
        worker: { effort: "auto" },
        reviewer: { model: "auto" },
      },
      reviewPass: true,
      maxParallelRuns: 3,
    });
    expect(opts.timeoutMs).toBe(30_000);
    const text = (out as { text: string }).text;
    expect(text).toMatch(/^Changed: effort, roleModels, reviewPass, maxParallelRuns\./);
    expect(text).toContain("Coding team settings");
  });

  it("sends an empty string through, so a commit-identity half can be cleared", async () => {
    await harness().call("coding_settings_set", { git_author_email: "" });
    expect(apiPost.mock.calls[0][1]).toEqual({ gitAuthorEmail: "" });
  });

  it("says what happened to Claude Code's transcript period when the history setting moved", async () => {
    apiPost.mockResolvedValue({ changed: ["historyRetention"], transcripts: [{ file: "/x/settings.json", state: "pinned" }], settings: SETTINGS });
    const text = (await harness().call("coding_settings_set", { history_retention: "everything" }) as { text: string }).text;
    expect(text).toContain("Changed: historyRetention.");
    expect(text).toContain("transcript period was pinned");
  });

  it("refuses an empty call as BAD_ARGUMENT without a request", async () => {
    const out = await harness().call("coding_settings_set", {});
    expect(out.isError).toBe(true);
    expect((out as { error: { code: string; next: string } }).error.code).toBe("BAD_ARGUMENT");
    expect((out as { error: { next: string } }).error.next).toContain("coding_settings_get");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("passes the route's own sentence through on a refused value, as BAD_ARGUMENT with no retry of the same value", async () => {
    apiPost.mockRejectedValue(new ApiError(400, JSON.stringify({ error: "The number of runs at once must be a whole number between 1 and 4.", kind: "invalid" })));
    const out = await harness().call("coding_settings_set", { max_parallel_runs: 9 });
    expect(out.isError).toBe(true);
    const err = (out as { error: { code: string; message: string; next: string } }).error;
    expect(err.code).toBe("BAD_ARGUMENT");
    expect(err.message).toContain("between 1 and 4");
    expect(err.next).toContain("Do not retry the same value");
  });

  it("turns an owner-only field's refusal into CONFLICT naming the Settings page, never to retry", async () => {
    apiPost.mockRejectedValue(new ApiError(400, JSON.stringify({ error: '"enabled" is not a setting the assistant may change.', kind: "owner_setting" })));
    const out = await harness().call("coding_settings_set", { review_pass: true });
    expect(out.isError).toBe(true);
    const err = (out as { error: { code: string; message: string; next: string } }).error;
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("owner's alone");
    expect(err.next).toContain("Do not retry");
    expect(err.next).toContain("Settings page");
  });

  it("turns a 403 into CONFLICT with the Settings page named", async () => {
    apiPost.mockRejectedValue(new ApiError(403, JSON.stringify({ error: "no", kind: "owner_only" })));
    const err = (await harness().call("coding_settings_set", { review_pass: true }) as { error: { code: string; next: string } }).error;
    expect(err.code).toBe("CONFLICT");
    expect(err.next).toContain("Settings page");
  });
});
