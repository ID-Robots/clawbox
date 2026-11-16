/**
 * Which automations the box adopts onto the account the gateway leads with,
 * and how (TASK-2533) — the planner alone, `cron.list` and the box's records
 * in, `cron.update` steps out. The whole round trip against a stand-in for
 * core is in anthropic-gateway.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
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
    // A disabled job is not touched at all, its lost run neither (below).
    expect(plan([job({ id: "j", ...failed, enabled: false, lastRunAtMs: NOW - 1000 })], {})).toEqual([]);
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

describe("a disabled job is never touched (pool renewal keeps cron binding)", () => {
  const pinned = `anthropic/claude-sonnet-5-5@${POOL_A}`;
  const lost = { lastStatus: "error", lastError: "Automation inference account was replaced. Explicitly select an authorized account again.", lastRunAtMs: NOW - 1000 };

  it("plans nothing for a disabled job: not a renewal's re-adoption, not a swap, not a lost run, not an owed clear, not a give-back", () => {
    const records: CronBindingRecords = {
      renewed: { profileId: POOL_A, authorization: "life-1", inherits: false, model: pinned, revision: "r1", at: NOW - 60_000 },
      clear: { profileId: POOL_A, authorization: "life-1", inherits: true, model: `anthropic/claude-opus-5-5@${POOL_A}`, revision: "r1", at: NOW - 60_000 },
    };
    const jobs = [
      job({ id: "renewed", model: pinned, enabled: false }),
      job({ id: "clear", model: `anthropic/claude-opus-5-5@${POOL_A}`, enabled: false }),
      job({ id: "new", enabled: false }),
      job({ id: "lost", model: pinned, enabled: false, ...lost }),
    ];
    // A renewal (same account, new lifetime) and a swap (another account).
    expect(plan(jobs, records, { profileId: POOL_A, authorization: "life-2" })).toEqual([]);
    expect(plan(jobs, records, { profileId: POOL_B, authorization: "life-9" })).toEqual([]);
    // The pool left: nothing given back either.
    expect(planCronBindings({ jobs, target: null, records, defaultModel: "anthropic/claude-opus-5-5", isPoolProfile: isPool, onlyAdopted: true, accountFor: () => "anthropic:default", now: NOW })).toEqual([]);
  });

  it("a renewal re-adopts an enabled job pinned to the renewed account onto that SAME account — never another — and a job on an account outside the pool stays as it is", () => {
    const records: CronBindingRecords = { j: { profileId: POOL_A, authorization: "life-1", inherits: false, model: pinned, revision: "r1", at: NOW - 60_000 } };
    const plans = plan([
      job({ id: "j", model: pinned }),
      job({ id: "owners", model: "anthropic/claude-sonnet-5-5@anthropic:default" }),
      job({ id: "work", model: "anthropic/claude-sonnet-5-5@anthropic:work-key" }),
    ], records, { profileId: POOL_A, authorization: "life-2" });
    expect(plans.map((p) => [p.job.id, p.steps])).toEqual([["j", [pinned]]]);
  });

  it("an enabled-again job is planned from its new revision on the next pass", () => {
    const records: CronBindingRecords = { j: { profileId: POOL_A, authorization: "life-1", inherits: false, model: pinned, revision: "r1", at: NOW - 60_000 } };
    expect(plan([job({ id: "j", model: pinned, enabled: false, revision: "r1" })], records, { profileId: POOL_A, authorization: "life-2" })).toEqual([]);
    expect(plan([job({ id: "j", model: pinned, enabled: true, revision: "r2" })], records, { profileId: POOL_A, authorization: "life-2" }).map((p) => p.steps)).toEqual([[pinned]]);
  });

  it("sends no update and no run for a disabled job, keeps its record, and says nothing of its lost run", async () => {
    const calls: string[] = [];
    let stored: CronBindingRecords = { off: { profileId: POOL_A, authorization: "life-1", inherits: false, model: pinned, revision: "r1", at: NOW - 60_000 } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps: CronBindingDeps = {
        call: async (method, params) => {
          calls.push(`${method}:${String(params.id ?? "")}`);
          if (method === "cron.list") {
            return { jobs: [
              { id: "off", enabled: false, sessionTarget: "isolated", configRevision: "r1", payload: { kind: "agentTurn", model: pinned }, state: lost },
              { id: "off-unbound", enabled: false, sessionTarget: "isolated", configRevision: "r1", payload: { kind: "agentTurn", model: "anthropic/claude-sonnet-5-5" }, state: lost },
            ] };
          }
          return { ok: true, configRevision: "r2" };
        },
        readRecords: async () => stored,
        writeRecords: async (r) => {
          stored = structuredClone(r);
        },
      };
      const result = await bindCronsToTarget(deps, { target: { profileId: POOL_A, authorization: "life-2" }, defaultModel: "anthropic/claude-opus-5-5", isPoolProfile: isPool, now: NOW });
      expect(result).toMatchObject({ bound: 0, owed: 0, rerun: 0, released: 0, unread: false });
      expect(calls.filter((c) => !c.startsWith("cron.list"))).toEqual([]);
      expect(stored.off).toMatchObject({ profileId: POOL_A, authorization: "life-1", model: pinned });
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/off-unbound|lost its run/);
    } finally {
      errors.mockRestore();
    }
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

describe("running a lost run again (CodeRabbit review of 8ac63f2 on #1526)", () => {
  const failed = { lastError: "Automation inference account was replaced. Explicitly select an authorized account again.", lastRunAtMs: NOW - 1000 };
  const records: CronBindingRecords = { j: { profileId: POOL_A, authorization: "life-1", inherits: true, model: null, revision: "r1", at: NOW - 60_000 } };
  const input = { target: { profileId: POOL_A, authorization: "life-2" }, defaultModel: "anthropic/claude-opus-5-5", isPoolProfile: isPool, now: NOW };
  /** cron.list with the lost run; the store fails the writes named (1-based). */
  function fakeDeps(failWrites: number[] = [], opts: { model?: string; records?: CronBindingRecords } = {}) {
    const calls: string[] = [];
    let stored: CronBindingRecords = structuredClone(opts.records ?? records);
    let writes = 0;
    const storedAtRun: CronBindingRecords[] = [];
    const deps: CronBindingDeps = {
      call: async (method) => {
        calls.push(method);
        if (method === "cron.list") {
          return { jobs: [{ id: "j", sessionTarget: "isolated", configRevision: "r1", payload: { kind: "agentTurn", ...(opts.model ? { model: opts.model } : {}) }, state: { lastStatus: "error", ...failed } }] };
        }
        if (method === "cron.run") storedAtRun.push(structuredClone(stored));
        return { ok: true, configRevision: "r2" };
      },
      readRecords: async () => stored,
      writeRecords: async (r) => {
        writes += 1;
        if (failWrites.includes(writes)) throw new Error("disk full");
        stored = structuredClone(r);
      },
    };
    // Refusals and reports of their own: the tests above left job "j" backed off in the module's.
    const run = (now = NOW) => ({ ...input, now, refused: new Map(), reported: new Map() });
    return { deps, calls, stored: () => stored, storedAtRun, run };
  }

  it("writes the confirmed adoption and its retry reservation before the run is started", async () => {
    const f = fakeDeps();
    expect(await bindCronsToTarget(f.deps, f.run())).toMatchObject({ bound: 1, rerun: 1, owed: 0 });
    expect(f.calls.filter((m) => m === "cron.run")).toHaveLength(1);
    // Durable when core was asked to run it: a pass that reads the store then forces nothing again.
    expect(f.storedAtRun[0].j).toMatchObject({ retriedAt: NOW, authorization: "life-2" });
    expect(f.storedAtRun[0].j.provisional).toBeUndefined();
    // The job as core left it (its revision the update's answer).
    expect(planCronBindings({ ...input, now: NOW + 60_000, jobs: [job({ id: "j", revision: "r2", lastStatus: "error", ...failed })], records: f.storedAtRun[0] })).toEqual([]);
  });

  it("starts no run when the reservation cannot be written, and leaves the retry pending for the next pass", async () => {
    // The provisional record lands (write 1); the reservation does not (write 2); the pass's last write does.
    const f = fakeDeps([2]);
    expect(await bindCronsToTarget(f.deps, f.run())).toMatchObject({ rerun: 0, owed: 1 });
    expect(f.calls.filter((m) => m === "cron.run")).toEqual([]);
    const after = f.stored();
    expect(after.j.retriedAt).toBeUndefined();
    // The job is as the adoption left it (model-less again): the next pass still runs it once.
    expect(planCronBindings({ ...input, now: NOW + 60_000, jobs: [job({ id: "j", lastStatus: "error", ...failed })], records: after })[0]).toMatchObject({ retry: true });

    // ...and does: the store answers again.
    const again = await bindCronsToTarget(f.deps, f.run(NOW + 60_000));
    expect(again).toMatchObject({ rerun: 1 });
    expect(f.storedAtRun[0].j).toMatchObject({ retriedAt: NOW + 60_000 });
  });

  it("starts no run when no write after the adoption lands", async () => {
    const f = fakeDeps([2, 3]);
    expect(await bindCronsToTarget(f.deps, f.run())).toMatchObject({ rerun: 0 });
    expect(f.calls.filter((m) => m === "cron.run")).toEqual([]);
    expect(planCronBindings({ ...input, now: NOW + 60_000, jobs: [job({ id: "j", lastStatus: "error", ...failed })], records: f.stored() })[0]).toMatchObject({ retry: true });
  });

  it("a job left pinned to the default stays the box's to give back when its reservation cannot be written", async () => {
    // Its clear did not land last time: pinned to the default on a pool profile, its record model-less.
    const pin = `anthropic/claude-opus-5-5@${POOL_B}`;
    const pinned: CronBindingRecords = { j: { profileId: POOL_B, authorization: "life-1", inherits: true, model: null, revision: "r1", at: NOW - 60_000 } };
    const f = fakeDeps([2], { model: pin, records: pinned });
    expect(await bindCronsToTarget(f.deps, f.run())).toMatchObject({ bound: 1, rerun: 0, owed: 1 });
    expect(f.calls.filter((m) => m === "cron.run")).toEqual([]);
    const after = f.stored();
    // Both updates landed: the job is model-less again, bound to A.
    const now = job({ id: "j", revision: "r2", lastStatus: "error", ...failed });
    expect(planCronBindings({ ...input, now: NOW + 60_000, jobs: [now], records: after })[0]).toMatchObject({ retry: true });
    // The pool leaves before that pass: the job is still given back (A went with the pool).
    const back = planCronBindings({ ...input, target: null, onlyAdopted: true, accountFor: () => "anthropic:default", now: NOW + 60_000, jobs: [now], records: after });
    expect(back).toMatchObject([{ release: true, steps: ["anthropic/claude-opus-5-5@anthropic:default", null] }]);
  });
});
