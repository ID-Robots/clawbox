import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  readConfigStrict: vi.fn(),
  restartGateway: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
}));
vi.mock("@/lib/hermes-config-yaml", () => ({
  patchHermesConfig: vi.fn(),
  readHermesConfigValue: vi.fn(),
}));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn() }));

// TASK-609. OpenClaw 2 arrives with heartbeat DMs, memory dreaming and
// self-learning all on, spending the owner's subscription and messaging him
// without being asked. These are the switches, and the properties that matter
// are the ones a panel can get wrong in a way nobody notices:
//
//   * an ABSENT key means the core's own default, and all three defaults are
//     ON — reading absence as "off" would show an unseeded box as already quiet;
//   * switching one ON removes ClawBox's opt-out rather than pinning a value of
//     our own, so the core keeps deciding the cadence;
//   * the write is read BACK before the switch reports success;
//   * Hermes has no heartbeat at all, and says so rather than drawing a switch.

let GET: () => Promise<Response>;
let POST: (req: Request) => Promise<Response>;
let getActiveHarness: Mock;
let readConfigStrict: Mock;
let restartGateway: Mock;
let runOpenclawConfigSet: Mock;
let runOpenclawConfigUnset: Mock;
let patchHermesConfig: Mock;
let readHermesConfigValue: Mock;
let hasOwnerSession: Mock;

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
  ({ readConfigStrict, restartGateway, runOpenclawConfigSet, runOpenclawConfigUnset } =
    (await import("@/lib/openclaw-config")) as unknown as {
      readConfigStrict: Mock; restartGateway: Mock; runOpenclawConfigSet: Mock; runOpenclawConfigUnset: Mock;
    });
  ({ patchHermesConfig, readHermesConfigValue } =
    (await import("@/lib/hermes-config-yaml")) as unknown as { patchHermesConfig: Mock; readHermesConfigValue: Mock });
  ({ hasOwnerSession } = (await import("@/lib/owner-session")) as unknown as { hasOwnerSession: Mock });
  getActiveHarness.mockResolvedValue("openclaw");
  readConfigStrict.mockResolvedValue({});
  restartGateway.mockResolvedValue(undefined);
  runOpenclawConfigSet.mockResolvedValue(undefined);
  runOpenclawConfigUnset.mockResolvedValue(undefined);
  readHermesConfigValue.mockResolvedValue(null);
  patchHermesConfig.mockResolvedValue({ mode: "merge", backupPath: null });
  hasOwnerSession.mockResolvedValue(true);
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

describe("background-jobs — the switches", () => {
  it("refuses the agent", async () => {
    hasOwnerSession.mockResolvedValue(false);
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
