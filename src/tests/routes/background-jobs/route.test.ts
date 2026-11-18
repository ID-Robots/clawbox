import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  callGatewayRpc: vi.fn(),
  readConfigStrict: vi.fn(),
  restartGateway: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
}));
// The comparison stays real (it is what answers "cannot tell"); only the manifest read is the test's.
vi.mock("@/lib/openclaw-core-generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-core-generation")>()),
  installedOpenclawCoreVersion: vi.fn(),
}));
vi.mock("@/lib/hermes-config-yaml", () => ({
  patchHermesConfig: vi.fn(),
  readHermesConfigValue: vi.fn(),
}));
vi.mock("@/lib/owner-session", () => ({ hasPersonSession: vi.fn() }));

// OpenClaw 2 arrives with heartbeat DMs, memory dreaming and self-learning all
// on, spending the owner's subscription and messaging him without being asked
// — and since the owner's ruling of 2026-09-15 that IS the default (TASK-609's
// opt-outs are taken back once at boot). These are the switches, and the
// properties that matter are the ones a panel can get wrong in a way nobody
// notices:
//
//   * an ABSENT key means the core's own default, and all three defaults are
//     ON — reading absence as "off" would show a fresh box as already quiet;
//   * switching one ON removes the key rather than pinning a value of our
//     own, so the core keeps deciding the cadence;
//   * the write is read BACK before the switch reports success;
//   * Hermes has no heartbeat at all, and says so rather than drawing a switch.

let GET: () => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let getActiveHarness: Mock;
let readConfigStrict: Mock;
let restartGateway: Mock;
let callGatewayRpc: Mock;
let installedOpenclawCoreVersion: Mock;
let runOpenclawConfigSet: Mock;
let runOpenclawConfigUnset: Mock;
let patchHermesConfig: Mock;
let readHermesConfigValue: Mock;
let hasPersonSession: Mock;

function post(body: unknown) {
  return POST(new Request("http://x/setup-api/background-jobs", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

interface Row { id: string; enabled: boolean; supported: boolean; key: string | null }

async function rows(): Promise<Row[]> {
  return ((await (await GET()).json()) as { jobs: Row[] }).jobs;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ callGatewayRpc, readConfigStrict, restartGateway, runOpenclawConfigSet, runOpenclawConfigUnset } =
    (await import("@/lib/openclaw-config")) as unknown as {
      callGatewayRpc: Mock; readConfigStrict: Mock; restartGateway: Mock; runOpenclawConfigSet: Mock; runOpenclawConfigUnset: Mock;
    });
  ({ installedOpenclawCoreVersion } =
    (await import("@/lib/openclaw-core-generation")) as unknown as { installedOpenclawCoreVersion: Mock });
  ({ patchHermesConfig, readHermesConfigValue } =
    (await import("@/lib/hermes-config-yaml")) as unknown as { patchHermesConfig: Mock; readHermesConfigValue: Mock });
  ({ hasPersonSession } = (await import("@/lib/owner-session")) as unknown as { hasPersonSession: Mock });
  getActiveHarness.mockResolvedValue("openclaw");
  readConfigStrict.mockResolvedValue({});
  // A core that still has the heartbeat key, unless a test says it retired it.
  installedOpenclawCoreVersion.mockResolvedValue("2026.11.3");
  callGatewayRpc.mockRejectedValue(new Error("the key-based path must not ask the gateway"));
  restartGateway.mockResolvedValue(undefined);
  runOpenclawConfigSet.mockResolvedValue(undefined);
  runOpenclawConfigUnset.mockResolvedValue(undefined);
  readHermesConfigValue.mockResolvedValue(null);
  patchHermesConfig.mockResolvedValue({ mode: "merge", backupPath: null });
  hasPersonSession.mockResolvedValue(true);
  ({ GET, POST } = await import("@/app/setup-api/background-jobs/route"));
});

describe("background-jobs — reading the box", () => {
  it("reports all three ON when the config says nothing, because that is the core's default", async () => {
    for (const row of await rows()) expect([row.id, row.enabled]).toEqual([row.id, true]);
  });

  it("reads 0m as off and any other cadence as on", async () => {
    readConfigStrict.mockResolvedValue({ agents: { defaults: { heartbeat: { every: "0m" } } } });
    expect((await rows()).find((r) => r.id === "checkIns")?.enabled).toBe(false);
    readConfigStrict.mockResolvedValue({ agents: { defaults: { heartbeat: { every: "30m" } } } });
    expect((await rows()).find((r) => r.id === "checkIns")?.enabled).toBe(true);
  });

  it("names the harness key behind every row", async () => {
    const byId = new Map((await rows()).map((r) => [r.id, r]));
    expect(byId.get("checkIns")?.key).toBe("agents.defaults.heartbeat.every");
    expect(byId.get("memoryReview")?.key).toBe("plugins.entries.memory-core.config.dreaming.enabled");
    expect(byId.get("skillLearning")?.key).toBe("skills.workshop.autonomous.mode");
  });

  it("says Hermes has no heartbeat rather than drawing an off switch", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    const byId = new Map((await rows()).map((r) => [r.id, r]));
    expect(byId.get("checkIns")?.supported).toBe(false);
    expect(byId.get("memoryReview")?.key).toBe("auxiliary.background_review.enabled");
    expect(byId.get("skillLearning")?.key).toBe("curator.enabled");
    // Hermes' own defaults for both are `true`.
    expect(byId.get("memoryReview")?.enabled).toBe(true);
  });
});

// TASK-2387: the panel says why dreaming and the background review are off on
// a box whose chats share one engine. Only on OpenClaw: the flag does not touch
// Hermes' keys, so saying "off by default" there would be untrue.
describe("background-jobs — a single-engine box", () => {
  async function singleEngine(): Promise<unknown> {
    return ((await (await GET()).json()) as { singleEngine?: unknown }).singleEngine;
  }

  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv("CLAWBOX_SINGLE_ENGINE");
  });
  afterEach(() => restore());

  it("says so on OpenClaw when CLAWBOX_SINGLE_ENGINE is set", async () => {
    process.env.CLAWBOX_SINGLE_ENGINE = "1";
    expect(await singleEngine()).toBe(true);
    process.env.CLAWBOX_SINGLE_ENGINE = " TRUE ";
    expect(await singleEngine()).toBe(true);
    // A hand-written `"1"` the loader left quoted: the boot script strips it too.
    process.env.CLAWBOX_SINGLE_ENGINE = '"1"';
    expect(await singleEngine()).toBe(true);
  });

  it("does not on a box without the flag, or with it off", async () => {
    delete process.env.CLAWBOX_SINGLE_ENGINE;
    expect(await singleEngine()).toBe(false);
    process.env.CLAWBOX_SINGLE_ENGINE = "0";
    expect(await singleEngine()).toBe(false);
  });

  it("never does on Hermes, whose keys the flag leaves alone", async () => {
    process.env.CLAWBOX_SINGLE_ENGINE = "1";
    getActiveHarness.mockResolvedValue("hermes");
    expect(await singleEngine()).toBe(false);
  });

  it("still says so on OpenClaw when the config cannot be read", async () => {
    process.env.CLAWBOX_SINGLE_ENGINE = "1";
    readConfigStrict.mockRejectedValue(new Error("EACCES"));
    const body = (await (await GET()).json()) as { degraded: boolean; singleEngine: boolean };
    expect(body.degraded).toBe(true);
    expect(body.singleEngine).toBe(true);
  });
});

describe("background-jobs — the switches", () => {
  it("refuses the agent", async () => {
    hasPersonSession.mockResolvedValue(false);
    const r = await post({ id: "checkIns", enabled: true });
    expect(r.status).toBe(403);
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
  });

  it("writes 0m to switch the check-ins off", async () => {
    readConfigStrict
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ agents: { defaults: { heartbeat: { every: "0m" } } } });
    const r = await post({ id: "checkIns", enabled: false });
    expect(r.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith(["agents.defaults.heartbeat.every", "0m"]);
  });

  it("UNSETS the key to switch them back on, rather than pinning a cadence", async () => {
    // The core's own default is 30 m — an hour on Anthropic OAuth — and that is
    // not a distinction ClawBox has any business freezing.
    readConfigStrict
      .mockResolvedValueOnce({ agents: { defaults: { heartbeat: { every: "0m" } } } })
      .mockResolvedValueOnce({ agents: { defaults: { heartbeat: { every: "0m" } } } })
      .mockResolvedValueOnce({});
    const r = await post({ id: "checkIns", enabled: true });
    expect(r.status).toBe(200);
    expect(runOpenclawConfigUnset).toHaveBeenCalledWith("agents.defaults.heartbeat.every");
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
  });

  it("reads the write back and refuses to claim a change that did not land", async () => {
    // The config still says `auto` afterwards: the switch must not answer ok.
    readConfigStrict.mockResolvedValue({ skills: { workshop: { autonomous: { mode: "auto" } } } });
    const r = await post({ id: "skillLearning", enabled: false });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, code: "write_failed" });
  });

  it("never verifies against a config the box could not read", async () => {
    // `readConfigStrict` throws, the status is degraded, and every row in a
    // degraded status happens to read as ON — so an "on" write would otherwise
    // wave itself through over a config that still says `0m`.
    readConfigStrict.mockRejectedValue(new Error("EACCES"));
    const r = await post({ id: "checkIns", enabled: true });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ code: "write_failed" });
  });

  it("answers 409 for a job this edition does not have", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    const r = await post({ id: "checkIns", enabled: false });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "unsupported" });
    expect(patchHermesConfig).not.toHaveBeenCalled();
  });

  it("writes Hermes' own key on Hermes", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    readHermesConfigValue.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce("false").mockResolvedValueOnce(null);
    const r = await post({ id: "memoryReview", enabled: false });
    expect(r.status).toBe(200);
    expect(patchHermesConfig).toHaveBeenCalledWith({ set: { "auxiliary.background_review.enabled": "false" } });
    // Nothing to restart: Hermes caches its config on the file's own mtime and
    // size and asks `is_background_review_enabled()` at each spawn, so the next
    // turn already obeys the write (checked read-only on the box). `null`, not
    // `false` — the panel renders `false` as "it takes effect when the assistant
    // next restarts", which would be untrue of a write already in force.
    expect(await r.json()).toMatchObject({ restarted: null });
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("says whether the restart happened rather than folding it into the verdict", async () => {
    readConfigStrict
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ agents: { defaults: { heartbeat: { every: "0m" } } } });
    restartGateway.mockRejectedValue(new Error("gateway did not come back"));
    const r = await post({ id: "checkIns", enabled: false });
    // The setting IS written; only the "take effect now" half failed.
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, restarted: false });
  });
  it("answers bad_request for a body that parses to null, not an unstructured 500", async () => {
    // `JSON.parse("null")` succeeds, so the `catch` never runs and the cast
    // changes nothing at runtime: reading `.id` off it threw out of the handler.
    const r = await POST(new Request("http://x/setup-api/background-jobs", {
      method: "POST",
      body: "null",
    }));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ ok: false, code: "bad_request" });
  });
});

// OpenClaw 2026.11.5 retired `agents.defaults.heartbeat`: Doctor turns the
// monitor into an ordinary automation job and removes the key, so the config
// says NOTHING about check-ins any more and an absent key no longer means "on".
// Measured on a lab board updated from 2026.11.3 with the check-ins switched
// OFF: the config lost the key, `heartbeat-main` came out DISABLED, and the
// key-based panel answered ON. These are the properties that keep the switch
// honest over the job.
describe("background-jobs — OpenClaw 2026.11.5, where the heartbeat is an automation job", () => {
  interface Job { id: string; name: string; enabled: boolean; agentId?: string | null; payload?: { kind: string } }
  let jobs: Job[];

  /** What `cron.list` carries of a monitor Doctor converted (measured). */
  const monitor = (over: Partial<Job> = {}): Job => ({
    id: "hb", name: "heartbeat-main", agentId: "main", enabled: false, payload: { kind: "agentTurn" }, ...over,
  });
  const dreaming = (): Job => ({ id: "dream", name: "Memory Dreaming Promotion", agentId: null, enabled: true, payload: { kind: "agentTurn" } });

  function gateway(opts: { pages?: Job[][] } = {}) {
    callGatewayRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "cron.list") {
        const pages = opts.pages ?? [jobs];
        const at = Math.floor(Number(params.offset ?? 0) / 200);
        const more = at < pages.length - 1;
        return { jobs: pages[at], hasMore: more, ...(more ? { nextOffset: (at + 1) * 200 } : {}) };
      }
      if (method === "cron.update") {
        const patch = params.patch as { enabled: boolean };
        const job = jobs.find((j) => j.id === params.id);
        if (!job) throw new Error("no such job");
        job.enabled = patch.enabled;
        return { ok: true };
      }
      throw new Error(`unexpected ${method}`);
    });
  }
  const updates = () => callGatewayRpc.mock.calls.filter(([m]) => m === "cron.update");
  const checkIns = async () => (await rows()).find((r) => r.id === "checkIns");

  beforeEach(() => {
    installedOpenclawCoreVersion.mockResolvedValue("2026.11.5");
    jobs = [dreaming(), monitor()];
    gateway();
  });

  it("reads the job, not the key: an OFF monitor reads OFF", async () => {
    // The config has no heartbeat key at all (Doctor removed it), which the
    // key-based reading took for the core's default, ON.
    expect(await checkIns()).toEqual({ id: "checkIns", enabled: false, supported: true, key: "automation: heartbeat-main" });
  });

  it("reads an enabled monitor as ON, whichever name the core gave it", async () => {
    jobs = [monitor({ id: "p", name: "Proactive check (main)", enabled: true })];
    expect(await checkIns()).toMatchObject({ enabled: true, supported: true });
    jobs = [monitor({ id: "h", name: "Heartbeat (kitchen)", agentId: "kitchen", enabled: true })];
    expect(await checkIns()).toMatchObject({ enabled: true, supported: true });
    jobs = [monitor({ id: "u", name: "HEARTBEAT-Main", enabled: true })];
    expect(await checkIns()).toMatchObject({ enabled: true, supported: true });
  });

  it("does not take any other automation for the monitor", async () => {
    jobs = [
      dreaming(),
      // looks like a monitor by name, belongs to another agent: an owner's own job
      monitor({ id: "x", name: "heartbeat-report", enabled: true }),
      // the right name for its agent, but not an agent turn (a legacy, unconverted monitor)
      monitor({ id: "y", enabled: true, payload: { kind: "heartbeat" } }),
      // no agent
      monitor({ id: "z", agentId: null, enabled: true }),
      monitor({ id: "w", name: "Heartbeat reports to my boss", enabled: true }),
      monitor({ id: "v", name: "my heartbeat check", enabled: true }),
    ];
    expect(await checkIns()).toEqual({ id: "checkIns", enabled: false, supported: false, key: null });
    // And switching never reaches them: there is no monitor to switch.
    const r = await post({ id: "checkIns", enabled: false });
    expect(r.status).toBe(409);
    expect(updates()).toEqual([]);
  });

  it("says there is no check-in job rather than drawing a switch for one", async () => {
    jobs = [dreaming()];
    expect(await checkIns()).toEqual({ id: "checkIns", enabled: false, supported: false, key: null });
    const r = await post({ id: "checkIns", enabled: true });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "unsupported" });
    expect(updates()).toEqual([]);
  });

  it("finds the monitor on a later page of a long job list", async () => {
    const filler: Job[] = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, name: `job ${i}`, agentId: null, enabled: true, payload: { kind: "agentTurn" } }));
    gateway({ pages: [filler, [monitor({ enabled: true })]] });
    expect(await checkIns()).toMatchObject({ enabled: true, supported: true });
  });

  it("asks the gateway for a short while only, so Settings does not hang over a gateway that is restarting", async () => {
    await rows();
    expect(callGatewayRpc).toHaveBeenCalledWith("cron.list", expect.objectContaining({ includeDisabled: true }), { timeoutMs: 8000 });
  });

  it("switches ON by enabling the job: no config write, no gateway restart", async () => {
    const r = await post({ id: "checkIns", enabled: true });
    expect(r.status).toBe(200);
    expect(callGatewayRpc).toHaveBeenCalledWith("cron.update", { id: "hb", patch: { enabled: true } });
    expect(jobs.find((j) => j.id === "hb")?.enabled).toBe(true);
    // The other automation is not the monitor and is never touched.
    expect(updates()).toHaveLength(1);
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    expect(runOpenclawConfigUnset).not.toHaveBeenCalled();
    // `null`: the edit is live, so "it takes effect when the assistant next restarts" would be untrue.
    expect(await r.json()).toMatchObject({ ok: true, restarted: null });
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("switches OFF by disabling every monitor that is enabled, and only those", async () => {
    jobs = [
      monitor({ id: "a", enabled: true }),
      monitor({ id: "b", name: "heartbeat-staff", agentId: "staff", enabled: false }),
      monitor({ id: "c", name: "Proactive check (kitchen)", agentId: "kitchen", enabled: true }),
    ];
    const r = await post({ id: "checkIns", enabled: false });
    expect(r.status).toBe(200);
    expect(updates().map(([, p]) => p.id).sort()).toEqual(["a", "c"]);
    expect(jobs.every((j) => !j.enabled)).toBe(true);
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("refuses to claim a switch ON when the core took it for one monitor and not another", async () => {
    // `some(enabled)` reads ON as soon as one monitor is on, so a half-applied
    // switch would have read back as the wanted state.
    jobs = [
      monitor({ id: "a", enabled: true }),
      monitor({ id: "b", name: "heartbeat-staff", agentId: "staff", enabled: false }),
    ];
    callGatewayRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "cron.list") return { jobs, hasMore: false };
      if (params.id === "b") return { ok: true }; // accepted, changed nothing
      return { ok: true };
    });
    const r = await post({ id: "checkIns", enabled: true });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, code: "write_failed" });
  });

  it("reads the job back and refuses to claim a change that did not land", async () => {
    callGatewayRpc.mockImplementation(async (method: string) => {
      if (method === "cron.list") return { jobs, hasMore: false };
      return { ok: true }; // cron.update says yes and changes nothing
    });
    const r = await post({ id: "checkIns", enabled: true });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, code: "write_failed" });
  });

  it("answers write_failed when the core refuses the edit", async () => {
    callGatewayRpc.mockImplementation(async (method: string) => {
      if (method === "cron.list") return { jobs, hasMore: false };
      throw new Error("automation changed under you");
    });
    const r = await post({ id: "checkIns", enabled: true });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ code: "write_failed" });
  });

  it("does not take a list that stops half way for the box's state", async () => {
    callGatewayRpc.mockResolvedValue({ jobs: [{ id: "x", name: "job", enabled: true }], hasMore: true });
    const status = (await (await GET()).json()) as { degraded: boolean; unreadable?: string[] };
    expect(status).toMatchObject({ degraded: true, unreadable: ["checkIns"] });
  });

  describe("when the check-ins cannot be read", () => {
    beforeEach(() => {
      callGatewayRpc.mockRejectedValue(new Error("gateway closed"));
    });

    it("says degraded for the check-ins row ALONE: the other two still read from the config", async () => {
      readConfigStrict.mockResolvedValue({
        plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
        skills: { workshop: { autonomous: { mode: "off" } } },
      });
      const status = (await (await GET()).json()) as { degraded: boolean; unreadable?: string[]; jobs: Row[] };
      expect(status.degraded).toBe(true);
      expect(status.unreadable).toEqual(["checkIns"]);
      expect(status.jobs.find((j) => j.id === "memoryReview")).toMatchObject({ enabled: false });
      expect(status.jobs.find((j) => j.id === "skillLearning")).toMatchObject({ enabled: false });
    });

    it("refuses to switch the check-ins, and writes nothing", async () => {
      const r = await post({ id: "checkIns", enabled: true });
      expect(r.status).toBe(502);
      expect(await r.json()).toMatchObject({ code: "write_failed" });
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(runOpenclawConfigUnset).not.toHaveBeenCalled();
      expect(updates()).toEqual([]);
    });

    it("still switches dreaming: a gateway that is down does not hold the config's own switches hostage", async () => {
      readConfigStrict
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } } });
      const r = await post({ id: "memoryReview", enabled: false });
      expect(r.status).toBe(200);
      expect(runOpenclawConfigSet).toHaveBeenCalledWith(["plugins.entries.memory-core.config.dreaming.enabled", "false", "--strict-json"]);
      expect(await r.json()).toMatchObject({ ok: true, degraded: true, unreadable: ["checkIns"] });
    });
  });

  describe("when the installed core's version cannot be read", () => {
    beforeEach(() => {
      installedOpenclawCoreVersion.mockResolvedValue(null);
    });

    it("does not read an absent key as ON: the check-ins row says it could not be read", async () => {
      // On a core that retired the key the absent key means nothing; reading it
      // as the older core's default is the false ON this switch exists to avoid.
      const status = (await (await GET()).json()) as { degraded: boolean; unreadable?: string[] };
      expect(status).toMatchObject({ degraded: true, unreadable: ["checkIns"] });
      expect(callGatewayRpc).not.toHaveBeenCalled();
    });

    it("refuses to switch the check-ins, whichever way, and writes nothing", async () => {
      for (const enabled of [true, false]) {
        const r = await post({ id: "checkIns", enabled });
        expect(r.status).toBe(502);
      }
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(runOpenclawConfigUnset).not.toHaveBeenCalled();
      expect(updates()).toEqual([]);
    });
  });

  it("leaves the other two switches on the config: dreaming still writes its key and restarts", async () => {
    readConfigStrict
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } } });
    const r = await post({ id: "memoryReview", enabled: false });
    expect(r.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith(["plugins.entries.memory-core.config.dreaming.enabled", "false", "--strict-json"]);
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(await r.json()).toMatchObject({ restarted: true });
  });

  it.each(["2026.11.3", "2026.11.4", "2026.10.9"])("keeps the key-based behaviour on %s, which still has the key", async (version) => {
    installedOpenclawCoreVersion.mockResolvedValue(version);
    readConfigStrict.mockResolvedValue({ agents: { defaults: { heartbeat: { every: "0m" } } } });
    expect(await checkIns()).toMatchObject({ enabled: false, key: "agents.defaults.heartbeat.every" });
    expect(callGatewayRpc).not.toHaveBeenCalled();
  });
});
