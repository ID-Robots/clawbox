/**
 * Which automations the box adopts onto the account the gateway leads with,
 * and how (TASK-2533) — the planner alone, `cron.list` and the box's records
 * in, `cron.update` steps out. The whole round trip against a stand-in for
 * core is in anthropic-gateway.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  BINDING_RETRY_WINDOW_MS,
  bindCronsToTarget,
  type CronBindingDeps,
  isAnthropicModel,
  parseCronDefinitions,
  planCronBindings,
  splitModelRef,
  type CronBindingRecords,
  type CronJobDefinition,
} from "@/lib/anthropic-cron-binding";

const POOL_A = "anthropic:clawbox-aaaa";
const POOL_B = "anthropic:clawbox-bbbb";
const isPool = (id: string) => id.startsWith("anthropic:clawbox-");
const NOW = 1_800_000_000_000;

const job = (over: Partial<CronJobDefinition> & { id: string }): CronJobDefinition => ({
  agentId: null, sessionTarget: "isolated", kind: "agentTurn", model: null, enabled: true, revision: "r1",
  lastStatus: null, lastError: null, lastRunAtMs: null, ...over,
});

const plan = (jobs: CronJobDefinition[], records: CronBindingRecords = {}, target = { profileId: POOL_A, authorization: "life-1" }) =>
  planCronBindings({ jobs, target, records, defaultModel: "anthropic/claude-opus-5-5", isPoolProfile: isPool, now: NOW });

describe("reading cron.list", () => {
  it("reads the fields the binding needs, flat or under state, and skips what has no id", () => {
    const jobs = parseCronDefinitions({ jobs: [
      { id: "a", name: "Morning digest", agentId: "main", sessionTarget: "isolated", enabled: false, configRevision: "x", payload: { kind: "agentTurn", model: "anthropic/claude-sonnet-5-5" }, state: { lastStatus: "error", lastError: "boom", lastRunAtMs: 5 } },
      { jobId: "b", payload: { kind: "systemEvent" }, lastRunStatus: "ok", lastRunAt: 7 },
      { payload: {} },
      null,
    ] });
    expect(jobs).toEqual([
      { id: "a", name: "Morning digest", agentId: "main", sessionTarget: "isolated", kind: "agentTurn", model: "anthropic/claude-sonnet-5-5", enabled: false, revision: "x", lastStatus: "error", lastError: "boom", lastRunAtMs: 5 },
      { id: "b", name: null, agentId: null, sessionTarget: null, kind: "systemEvent", model: null, enabled: true, revision: null, lastStatus: "ok", lastError: null, lastRunAtMs: 7 },
    ]);
  });

  it("splits a model reference at its last @ and knows a Claude model", () => {
    expect(splitModelRef(`anthropic/claude-opus-5-5@${POOL_A}`)).toEqual({ base: "anthropic/claude-opus-5-5", profileId: POOL_A });
    expect(splitModelRef("anthropic/claude-opus-5-5")).toEqual({ base: "anthropic/claude-opus-5-5", profileId: null });
    expect(isAnthropicModel("anthropic/claude-opus-5-5")).toBe(true);
    expect(isAnthropicModel("claude-sonnet-5-5")).toBe(true);
    expect(isAnthropicModel("openai/gpt-5.5")).toBe(false);
    expect(isAnthropicModel("openrouter/anthropic/claude-opus-5-5")).toBe(false);
  });
});

describe("planning the adoptions", () => {
  it("adopts a model-less job in two steps and a job with its own Claude model in one", () => {
    expect(plan([job({ id: "inherits" }), job({ id: "own", model: "anthropic/claude-sonnet-5-5" })]).map((p) => [p.job.id, p.steps])).toEqual([
      ["inherits", [`anthropic/claude-opus-5-5@${POOL_A}`, null]],
      ["own", [`anthropic/claude-sonnet-5-5@${POOL_A}`]],
    ]);
  });

  it("leaves another provider, the main session, another agent, and an account the owner chose alone — and a model-less job when the default is not Claude", () => {
    expect(plan([
      job({ id: "openai", model: "openai/gpt-5.5" }),
      job({ id: "main", sessionTarget: "main" }),
      job({ id: "event", kind: "systemEvent" }),
      job({ id: "research", agentId: "research" }),
      job({ id: "owners", model: "anthropic/claude-opus-5-5@anthropic:default" }),
    ])).toEqual([]);
    expect(planCronBindings({ jobs: [job({ id: "x" })], target: { profileId: POOL_A, authorization: "l" }, records: {}, defaultModel: "openai/gpt-5.5", isPoolProfile: isPool, now: NOW })).toEqual([]);
  });

  it("moves a job pinned to another pool account", () => {
    expect(plan([job({ id: "pinned", model: `anthropic/claude-sonnet-5-5@${POOL_B}` })])[0].steps).toEqual([`anthropic/claude-sonnet-5-5@${POOL_A}`]);
  });

  it("adopts again on a swap, a renewal, or an edit — and not otherwise", () => {
    const records: CronBindingRecords = { j: { profileId: POOL_A, authorization: "life-1", inherits: true, model: null, revision: "r1", at: NOW - 1000 } };
    expect(plan([job({ id: "j" })], records)).toEqual([]);
    expect(plan([job({ id: "j" })], records, { profileId: POOL_B, authorization: "life-9" })).toHaveLength(1);
    expect(plan([job({ id: "j" })], records, { profileId: POOL_A, authorization: "life-2" })).toHaveLength(1);
    expect(plan([job({ id: "j", revision: "r2" })], records)).toHaveLength(1);
  });

  it("finishes a clear that did not land, and moves a job it put on the owner's sign-in", () => {
    const pinned = `anthropic/claude-opus-5-5@${POOL_A}`;
    const records: CronBindingRecords = {
      j: { profileId: POOL_A, authorization: "life-1", inherits: true, model: pinned, revision: "r1", at: NOW - 1000 },
      s: { profileId: "anthropic:default", authorization: "own", inherits: false, model: "anthropic/claude-sonnet-5-5@anthropic:default", revision: "r1", at: NOW - 1000 },
    };
    const plans = plan([job({ id: "j", model: pinned }), job({ id: "s", model: "anthropic/claude-sonnet-5-5@anthropic:default" })], records);
    expect(plans.map((p) => [p.job.id, p.steps])).toEqual([["j", [null]], ["s", [`anthropic/claude-sonnet-5-5@${POOL_A}`]]]);
  });

  it("adopts a job whose last run failed on its account whatever the record says, and runs it again once — only while that run is recent", () => {
    const failed = { lastStatus: "error", lastError: "Automation inference account was replaced. Explicitly select an authorized account again." };
    const records: CronBindingRecords = { j: { profileId: POOL_A, authorization: "life-1", inherits: true, model: null, revision: "r1", at: NOW - 60_000 } };
    expect(plan([job({ id: "j", ...failed, lastRunAtMs: NOW - 1000 })], records)[0]).toMatchObject({ retry: true });
    // Run again lately and failed again: adopted again, not forced again inside the window.
    expect(plan([job({ id: "j", ...failed, lastRunAtMs: NOW - 1000 })], { j: { ...records.j, retriedAt: NOW - 30_000 } })[0]).toMatchObject({ retry: false });
    expect(plan([job({ id: "j", ...failed, lastRunAtMs: NOW - 120_000 })], records)).toEqual([]);
    const old = NOW - BINDING_RETRY_WINDOW_MS - 1;
    expect(plan([job({ id: "j", ...failed, lastRunAtMs: old })], {})[0]).toMatchObject({ retry: false });
    expect(plan([job({ id: "j", ...failed, enabled: false, lastRunAtMs: NOW - 1000 })], {})[0]).toMatchObject({ retry: false });
    // Any other failure is the model's, not the account's.
    expect(plan([job({ id: "j", lastStatus: "error", lastError: "You've hit your weekly limit", lastRunAtMs: NOW - 1000 })], records)).toEqual([]);
  });

  it("reads core's other wording for the same loss — the MCP authority contract's retirement of a `user` binding (the owner's box, 2026-11-15) — as lost to the account, record or no record", () => {
    // `model@profile` bindings (source user) are refused "MCP_AUTHORIZATION_RETIRED"; the records say they are current.
    const records: CronBindingRecords = { j: { profileId: POOL_A, authorization: "life-1", inherits: false, model: `anthropic/claude-sonnet-5-5@${POOL_A}`, revision: "r1", at: NOW - 60_000 } };
    for (const lastError of ["MCP authorization was disconnected or replaced", "McpConnectionAuthorityError: MCP_AUTHORIZATION_RETIRED"]) {
      const lost = { lastStatus: "error", lastError, lastRunAtMs: NOW - 1000 };
      expect(plan([job({ id: "j", model: `anthropic/claude-sonnet-5-5@${POOL_A}`, ...lost })], records)[0]).toMatchObject({ steps: [`anthropic/claude-sonnet-5-5@${POOL_A}`], retry: true });
      expect(plan([job({ id: "k", model: "anthropic/claude-sonnet-5-5", ...lost })], {})[0]).toMatchObject({ retry: true });
    }
    // Temporarily unavailable is not lost: nothing is re-bound for it.
    expect(plan([job({ id: "j", model: `anthropic/claude-sonnet-5-5@${POOL_A}`, lastStatus: "error", lastError: "MCP authorization state is temporarily unavailable", lastRunAtMs: NOW - 1000 })], records)).toEqual([]);
  });
});

describe("applying the adoptions (CodeRabbit review on #1526)", () => {
  /** A cron.list with one job, and a cron.update that answers as the test says. */
  function fakeDeps(opts: { model?: string | null; records?: CronBindingRecords | Error; writeFails?: boolean; updateFails?: boolean; lastError?: string; lastRunAtMs?: number }) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let stored: CronBindingRecords | Error = opts.records ?? {};
    const jobModel = opts.model ?? null;
    const deps: CronBindingDeps = {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "cron.list") {
          return { jobs: [{ id: "j", sessionTarget: "isolated", configRevision: "r1", payload: { kind: "agentTurn", ...(jobModel ? { model: jobModel } : {}) }, state: { lastStatus: opts.lastError ? "error" : "ok", lastError: opts.lastError, lastRunAtMs: opts.lastRunAtMs } }] };
        }
        if (method === "cron.update" && opts.updateFails) throw new Error("the scheduler is busy");
        return { ok: true, configRevision: "r2" };
      },
      readRecords: async () => {
        if (stored instanceof Error) throw stored;
        return stored;
      },
      writeRecords: async (r) => {
        if (opts.writeFails) throw new Error("disk full");
        stored = structuredClone(r);
      },
    };
    return { deps, calls, stored: () => stored };
  }
  const input = { target: { profileId: POOL_A, authorization: "life-2" }, defaultModel: "anthropic/claude-opus-5-5", isPoolProfile: isPool, now: NOW };

  it("changes nothing when the records cannot be read", async () => {
    const f = fakeDeps({ records: new Error("locked") });
    expect(await bindCronsToTarget(f.deps, input)).toMatchObject({ unread: true, bound: 0 });
    expect(f.calls.filter((c) => c.method === "cron.update")).toEqual([]);
  });

  it("touches no job before its record is written", async () => {
    const f = fakeDeps({ writeFails: true });
    expect(await bindCronsToTarget(f.deps, input)).toMatchObject({ owed: 1, bound: 0 });
    expect(f.calls.filter((c) => c.method === "cron.update")).toEqual([]);
  });

  it("does not take a provisional record for a confirmed adoption: a renewal's re-adoption core refused is planned again", async () => {
    const model = `anthropic/claude-sonnet-5-5@${POOL_A}`;
    const records: CronBindingRecords = { j: { profileId: POOL_A, authorization: "life-1", inherits: false, model, original: "anthropic/claude-sonnet-5-5", revision: "r1", at: NOW - 60_000 } };
    const f = fakeDeps({ model, records, updateFails: true });
    await bindCronsToTarget(f.deps, input);
    const after = f.stored() as CronBindingRecords;
    expect(after.j).toMatchObject({ provisional: true, authorization: "life-2", at: NOW - 60_000 });
    expect(planCronBindings({ ...input, jobs: [job({ id: "j", model, revision: "r1" })], records: after })).toHaveLength(1);
  });

  it("keeps a lost run lost when the adoption did not land: it is still run again once it does", async () => {
    const failed = { lastError: "Automation inference account was replaced. Explicitly select an authorized account again.", lastRunAtMs: NOW - 1000 };
    const records: CronBindingRecords = { j: { profileId: POOL_A, authorization: "life-1", inherits: true, model: null, revision: "r1", at: NOW - 60_000 } };
    const f = fakeDeps({ ...failed, records, updateFails: true });
    await bindCronsToTarget(f.deps, input);
    const after = f.stored() as CronBindingRecords;
    expect(planCronBindings({ ...input, jobs: [job({ id: "j", lastStatus: "error", ...failed })], records: after })[0]).toMatchObject({ retry: true });
  });
});
