/**
 * Which automations the box adopts onto the account the gateway leads with,
 * and how (TASK-2533) — the planner alone, `cron.list` and the box's records
 * in, `cron.update` steps out. The whole round trip against a stand-in for
 * core is in anthropic-gateway.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  BINDING_RETRY_WINDOW_MS,
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
      { id: "a", agentId: "main", sessionTarget: "isolated", enabled: false, configRevision: "x", payload: { kind: "agentTurn", model: "anthropic/claude-sonnet-5-5" }, state: { lastStatus: "error", lastError: "boom", lastRunAtMs: 5 } },
      { jobId: "b", payload: { kind: "systemEvent" }, lastRunStatus: "ok", lastRunAt: 7 },
      { payload: {} },
      null,
    ] });
    expect(jobs).toEqual([
      { id: "a", agentId: "main", sessionTarget: "isolated", kind: "agentTurn", model: "anthropic/claude-sonnet-5-5", enabled: false, revision: "x", lastStatus: "error", lastError: "boom", lastRunAtMs: 5 },
      { id: "b", agentId: null, sessionTarget: null, kind: "systemEvent", model: null, enabled: true, revision: null, lastStatus: "ok", lastError: null, lastRunAtMs: 7 },
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
});
