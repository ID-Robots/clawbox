/**
 * POST /setup-api/coding-agent/enable — the owner's switch.
 *
 * The property under test: the AGENT cannot flip it. Middleware admits the
 * MCP bearer to every /setup-api/* path and the agent holds that bearer, so
 * this route has to refuse it in-handler with the real cookie verifier, the
 * way email/pending does. A valid bearer and no credential get the identical
 * 403, so the answer leaks nothing about which one was tried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));

const setEnabled = vi.hoisted(() => vi.fn());
const getStatus = vi.hoisted(() => vi.fn());
const setEffort = vi.hoisted(() => vi.fn());
const setGenerateMedia = vi.hoisted(() => vi.fn());
const setRealBrowser = vi.hoisted(() => vi.fn());
const setTeamDynamic = vi.hoisted(() => vi.fn());
const clearHarnessFault = vi.hoisted(() => vi.fn());
const setAutoMerge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  setCodingAgentEnabled: setEnabled,
  // A Jetson-sized host: the ceiling the range checks below are written for.
  hostMaxParallelRuns: () => 4,
  getCodingAgentStatus: getStatus,
  setEffort,
  setGenerateMedia,
  setRealBrowser,
  setTeamDynamic,
  clearHarnessFault,
  setAutoMerge,
}));

// The reload is mocked at its own seam rather than at the refresh helper's, so
// this file pins the BEHAVIOUR the owner is owed — "the running agent is told" —
// and not the name of the module that happens to tell it.
const reloadMcp = vi.hoisted(() => vi.fn());
// Only the ASK is replaced; `reportMcpReloadRefused` stays real, so a refusal
// still travels the path it travels on a device.
vi.mock("@/lib/hermes-mcp-reload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-mcp-reload")>()),
  reloadMcpServers: reloadMcp,
}));

import { get as configGet, set as configSet, setMany as configSetMany } from "@/lib/config-store";

const SESSION_SECRET = "a".repeat(64);
const STATUS = { enabled: true, ready: false, readiness: { ready: false, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: false, problems: ["ClawBox AI is not connected."] }, running: 0, harnessCommand: "claude-ds", maxTaskChars: 4000 };

let POST: (req: Request) => Promise<Response>;
let restore: () => void;

function ownerCookie(gen = 0): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, gen)}`;
}

function request(init: { cookie?: string; bearer?: string; body?: unknown; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new Request("http://localhost/setup-api/coding-agent/enable", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? { enabled: true }),
  });
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  // A paid plan on record by default. The coding agent is a paid feature
  // (owner's decision, 2026-09-14) and `clawai_plan_tier` is what the gate
  // reads; the gate's own block below takes it away again. `flash` is the
  // plan marketed as Pro — the internal names are off by one.
  vi.mocked(configGet).mockImplementation(async (key: string) =>
    key === "clawai_plan_tier" ? "flash" : undefined);
  getStatus.mockResolvedValue(STATUS);
  setEnabled.mockResolvedValue(undefined);
  reloadMcp.mockResolvedValue(true);
  setEffort.mockResolvedValue("low");
  setGenerateMedia.mockResolvedValue(false);
  setRealBrowser.mockResolvedValue(false);
  setTeamDynamic.mockImplementation(async (on: boolean) => on);
  clearHarnessFault.mockResolvedValue(undefined);
  const route = await import("@/app/setup-api/coding-agent/enable/route");
  POST = route.POST;
});

afterEach(() => restore());

describe("who may flip the switch", () => {
  it("refuses the MCP bearer, which is what the agent holds", async () => {
    const res = await POST(request({ bearer: "any-valid-looking-token-value" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("refuses a request with no credential with the identical answer", async () => {
    const withBearer = await POST(request({ bearer: "any-valid-looking-token-value" }));
    const bare = await POST(request());
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual(await withBearer.json());
  });

  it("refuses a forged cookie", async () => {
    const res = await POST(request({ cookie: `clawbox_session=${createSessionCookie(3600, "b".repeat(64), 0)}` }));
    expect(res.status).toBe(403);
  });

  it("accepts the owner's browser session and answers the re-read status", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: true } }));
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(await res.json()).toEqual(STATUS);
  });

  it("turns it off the same way", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: false } }));
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(false);
  });

});

describe("the body", () => {
  it("must be { enabled: boolean }", async () => {
    for (const bad of ["true", 1, null, {}, []]) {
      const res = await POST(request({ cookie: ownerCookie(), body: { enabled: bad } }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("takes the one media switch, and names it in the refusal when a body carries nothing it knows", async () => {
    const off = await POST(request({ cookie: ownerCookie(), body: { generateMedia: false } }));
    expect(off.status).toBe(200);
    expect(setGenerateMedia).toHaveBeenCalledWith(false);
    const on = await POST(request({ cookie: ownerCookie(), body: { generateMedia: true } }));
    expect(on.status).toBe(200);
    expect(setGenerateMedia).toHaveBeenCalledWith(true);
    // A body with none of the route's fields has to say which fields exist, or
    // the caller is left guessing at the one that was misspelled.
    const empty = await POST(request({ cookie: ownerCookie(), body: { nonsense: 1 } }));
    expect(empty.status).toBe(400);
    const message = (await empty.json()).error as string;
    expect(message).toContain("{ generateMedia: boolean }");
    expect(message).not.toContain("generateImages");
    expect(message).not.toContain("generateAudio");
  });

  it("answers 400 to the knobs SCA C3 took away, and writes nothing for them", async () => {
    // The review rounds are a constant now (DEFAULT_REVIEW_ROUNDS); the attempts
    // at a deliverable and the token ceiling are gone altogether (SCA A2), and the
    // extended history's N went with its mode (SCA2 C1): a body that names one
    // alone is a body the route does not know.
    for (const body of [{ reviewRounds: 3 }, { completionAttempts: 2 }, { tokenLimit: 50_000 }, { tokenLimit: null }, { historyLimit: 300 }, { generateImages: false }, { generateAudio: false }]) {
      const res = await POST(request({ cookie: ownerCookie(), body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(configSet).not.toHaveBeenCalled();
    expect(configSetMany).not.toHaveBeenCalled();
    expect(setGenerateMedia).not.toHaveBeenCalled();
  });

  it("takes the real-browser switch, and names it in the refusal too", async () => {
    // The setup wizard's browser step writes exactly this, both ways: Enable
    // sends true, Skip sends false, and neither may be answered 400.
    const off = await POST(request({ cookie: ownerCookie(), body: { realBrowser: false } }));
    expect(off.status).toBe(200);
    expect(setRealBrowser).toHaveBeenCalledWith(false);
    const on = await POST(request({ cookie: ownerCookie(), body: { realBrowser: true } }));
    expect(on.status).toBe(200);
    expect(setRealBrowser).toHaveBeenCalledWith(true);

    const empty = await POST(request({ cookie: ownerCookie(), body: { nonsense: 1 } }));
    expect((await empty.json()).error as string).toContain("{ realBrowser: boolean }");
  });

  it("takes the team lead's switch both ways, and names it in the refusal too", async () => {
    const on = await POST(request({ cookie: ownerCookie(), body: { teamDynamic: true } }));
    expect(on.status).toBe(200);
    expect(setTeamDynamic).toHaveBeenCalledWith(true);
    const off = await POST(request({ cookie: ownerCookie(), body: { teamDynamic: false } }));
    expect(off.status).toBe(200);
    expect(setTeamDynamic).toHaveBeenLastCalledWith(false);
    // Not a boolean: not this switch, and nothing else in the body either.
    const bad = await POST(request({ cookie: ownerCookie(), body: { teamDynamic: "yes" } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error as string).toContain("{ teamDynamic: boolean }");
    expect(setTeamDynamic).toHaveBeenCalledTimes(2);
  });

  it("refuses the agent the team lead's switch — the owner's alone", async () => {
    // The bearer is what the assistant (and so a coding run, through the MCP
    // server) holds: it must not be able to let its own team rewrite plans.
    const res = await POST(request({ bearer: "any-valid-looking-token-value", body: { teamDynamic: true } }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(setTeamDynamic).not.toHaveBeenCalled();
  });

  it("takes both halves of the commit author, clears them, and refuses what git could not author", async () => {
    // The setter is deliberately REAL here: what is under test is that the
    // owner's identity reaches data/config.json under the keys the resolver
    // reads, in ONE write, and that a refusal comes back as a 400 in the
    // owner's words rather than a 500.
    const saved = await POST(request({
      cookie: ownerCookie(),
      body: { gitAuthorName: "Ada Lovelace", gitAuthorEmail: "ada@example.com" },
    }));
    expect(saved.status).toBe(200);
    expect(configSetMany).toHaveBeenCalledWith({
      coding_agent_git_name: "Ada Lovelace",
      coding_agent_git_email: "ada@example.com",
    });

    // `null` is the request that CLEARS one, not an empty body.
    const cleared = await POST(request({
      cookie: ownerCookie(),
      body: { gitAuthorName: null, gitAuthorEmail: null },
    }));
    expect(cleared.status).toBe(200);
    expect(configSetMany).toHaveBeenLastCalledWith({
      coding_agent_git_name: undefined,
      coding_agent_git_email: undefined,
    });

    // An address that is not one would be stored and then quietly ignored by
    // the resolver — a setting that reads as saved and does nothing.
    const bad = await POST(request({ cookie: ownerCookie(), body: { gitAuthorEmail: "nobody" } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).kind).toBe("invalid");

    // And a good name beside that bad address writes NOTHING. It used to store
    // the name and then answer 400, leaving half an identity behind.
    vi.mocked(configSetMany).mockClear();
    vi.mocked(configSet).mockClear();
    const half = await POST(request({
      cookie: ownerCookie(),
      body: { gitAuthorName: "Ada Lovelace", gitAuthorEmail: "nobody" },
    }));
    expect(half.status).toBe(400);
    expect(configSetMany).not.toHaveBeenCalled();
    expect(configSet).not.toHaveBeenCalled();

    const empty = await POST(request({ cookie: ownerCookie(), body: { nonsense: 1 } }));
    const message = (await empty.json()).error as string;
    expect(message).toContain("{ gitAuthorName: string | null }");
    expect(message).toContain("{ gitAuthorEmail: string | null }");
  });

  it("takes the merge switch, and names it in the refusal too", async () => {
    const merge = await POST(request({ cookie: ownerCookie(), body: { autoMerge: true } }));
    expect(merge.status).toBe(200);
    expect(setAutoMerge).toHaveBeenCalledWith(true);

    const empty = await POST(request({ cookie: ownerCookie(), body: { nonsense: 1 } }));
    const message = (await empty.json()).error as string;
    expect(message).toContain("{ autoMerge: boolean }");
    expect(message).not.toContain("reviewRounds");
  });

  it("takes the runs-at-once setting, refuses a value outside the range, and names it in the refusal", async () => {
    const ok = await POST(request({ cookie: ownerCookie(), body: { maxParallelRuns: 3 } }));
    expect(ok.status).toBe(200);

    for (const bad of [0, 5, 2.5, -1]) {
      const res = await POST(request({ cookie: ownerCookie(), body: { maxParallelRuns: bad } }));
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json()).error as string).toContain("between 1 and 4");
    }

    const empty = await POST(request({ cookie: ownerCookie(), body: { nonsense: 1 } }));
    expect((await empty.json()).error as string).toContain("{ maxParallelRuns: number }");
  });

  it("refuses a runs-at-once value BEFORE any other setting in the same body is saved", async () => {
    // The settings are applied one at a time, so a value refused halfway
    // through would answer 400 over an effort that had already moved. The
    // check sits with the folder-length one, ahead of the first setter.
    setEffort.mockClear();
    const res = await POST(request({ cookie: ownerCookie(), body: { effort: "high", maxParallelRuns: 9 } }));
    expect(res.status).toBe(400);
    expect(setEffort).not.toHaveBeenCalled();
  });

  it("refuses the agent the merge switch — a consent it must not give itself", async () => {
    const res = await POST(request({ bearer: "any-valid-looking-token-value", body: { autoMerge: true } }));
    expect(res.status).toBe(403);
    expect(setAutoMerge).not.toHaveBeenCalled();
  });

  it("refuses the agent this switch like every other", async () => {
    // Middleware admits the MCP bearer to /setup-api/*, and this route's whole
    // job is that the agent cannot change the owner's mind for them — the
    // browser it is watched in included.
    const res = await POST(request({ bearer: "any-valid-looking-token-value", body: { realBrowser: false } }));
    expect(res.status).toBe(403);
    expect(setRealBrowser).not.toHaveBeenCalled();
  });

  it("clears a recorded harness fault on the owner's say-so, and only on `true`", async () => {
    // The fault is what makes the box refuse runs after the harness proved it
    // could not get a model to answer. It expires on its own and a completed
    // run drops it, but an owner who has just signed in again or changed plan
    // should not have to wait out a clock to prove it.
    const cleared = await POST(request({ cookie: ownerCookie(), body: { clearHarnessFault: true } }));
    expect(cleared.status).toBe(200);
    expect(clearHarnessFault).toHaveBeenCalledTimes(1);

    // `false` is not the other half of a switch: there is no way to ASSERT a
    // fault from outside, which would be a way to disable the coding agent by
    // POST. A body carrying only that is a body the route knows nothing in.
    clearHarnessFault.mockClear();
    const asserted = await POST(request({ cookie: ownerCookie(), body: { clearHarnessFault: false } }));
    expect(asserted.status).toBe(400);
    expect(clearHarnessFault).not.toHaveBeenCalled();
    expect((await asserted.json()).error as string).toContain("{ clearHarnessFault: true }");
  });

  it("refuses the agent this one too — it is the party the refusal is protecting the owner from", async () => {
    const res = await POST(request({ bearer: "any-valid-looking-token-value", body: { clearHarnessFault: true } }));
    expect(res.status).toBe(403);
    expect(clearHarnessFault).not.toHaveBeenCalled();
  });

  it("rejects non-JSON", async () => {
    const res = await POST(request({ cookie: ownerCookie(), raw: "not json" }));
    expect(res.status).toBe(400);
  });

  it("checks the session before it looks at the body", async () => {
    const res = await POST(request({ raw: "not json" }));
    expect(res.status).toBe(403);
  });
});

/**
 * Flipping the switch has to reach the RUNNING agent, not just the browser.
 *
 * The coding_agent_* family is registered behind a probe the ClawBox MCP server
 * takes ONCE while it boots (`mcp/lib/context.ts` probeCodingAgent), and that
 * server is a long-lived stdio child of the agent. Before this, the route wrote
 * the setting, logged it and handed the browser a fresh status that said
 * "ready" — while the agent still had no coding_agent_run, coding_agent_status
 * or coding_agent_stop, until something unrelated respawned the child. Same
 * shape, and the same fix, as #486 (email_list/email_read) and #503 (the image
 * tools); this was the third call site of three and the only one left out.
 */
describe("telling the running agent", () => {
  /** Status before the write, then after it — the pair the refresh compares. */
  function readyGoes(before: boolean, after: boolean): void {
    getStatus
      .mockResolvedValueOnce({ ...STATUS, ready: before })
      .mockResolvedValueOnce({ ...STATUS, ready: after });
  }


  it("reloads the MCP servers when the switch makes the family available", async () => {
    readyGoes(false, true);
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: true } }));
    expect(res.status).toBe(200);
    expect(reloadMcp).toHaveBeenCalledTimes(1);
  });

  it("reloads them when the switch takes the family away", async () => {
    // The other direction matters as much: tools left registered against a
    // switch the owner turned off answer 409 forever, and a permanently-failing
    // tool is what opens Hermes' per-server circuit breaker.
    readyGoes(true, false);
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: false } }));
    expect(res.status).toBe(200);
    expect(reloadMcp).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload when the verdict did not move", async () => {
    // A reload respawns every MCP child and invalidates the model's prompt
    // cache. On a box with no harness installed the switch changes nothing the
    // agent can see, and the owner must not pay for that.
    readyGoes(false, false);
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: true } }));
    expect(res.status).toBe(200);
    expect(reloadMcp).not.toHaveBeenCalled();
  });

  it("reloads when clearing a harness fault makes the family available again", async () => {
    // A remembered fault makes `readiness.ready` false, so clearing one can
    // flip the family from unavailable to available — the same move the switch
    // makes, and it has to reach the running child the same way. Without this
    // the owner presses Try again, the panel says ready, and the agent still
    // has no coding_agent_run until something unrelated respawns it.
    readyGoes(false, true);
    const res = await POST(request({ cookie: ownerCookie(), body: { clearHarnessFault: true } }));
    expect(res.status).toBe(200);
    expect(clearHarnessFault).toHaveBeenCalledTimes(1);
    expect(reloadMcp).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload when clearing a fault changed no verdict", async () => {
    // Clearing a fault on a box that was already refusing runs for another
    // reason — no harness installed, ClawBox AI not connected — moves nothing
    // the agent can see, and a reload respawns every MCP child.
    readyGoes(false, false);
    const res = await POST(request({ cookie: ownerCookie(), body: { clearHarnessFault: true } }));
    expect(res.status).toBe(200);
    expect(reloadMcp).not.toHaveBeenCalled();
  });

  it("does NOT reload for the settings that leave the family alone", async () => {
    // effort, step limit, token ceiling, default folder — none of them change
    // WHICH tools exist, so none of them may cost a reload.
    const res = await POST(request({ cookie: ownerCookie(), body: { effort: "low" } }));
    expect(res.status).toBe(200);
    expect(reloadMcp).not.toHaveBeenCalled();
    // The media switch is read per RUN, at spawn, so it moves no tool on the
    // assistant's own long-lived server either.
    await POST(request({ cookie: ownerCookie(), body: { generateMedia: false } }));
    // The real-browser switch moves no tool either: browser_open and its
    // siblings exist whichever Chromium answers them.
    await POST(request({ cookie: ownerCookie(), body: { realBrowser: false } }));
    expect(reloadMcp).not.toHaveBeenCalled();
  });

  it("still saves the switch when the reload is refused", async () => {
    // The recurring shape this guards: an error path that reports failure over
    // something that actually succeeded. The write HAPPENED; a dashboard that
    // will not reload (an OpenClaw box has none at all) must not turn the
    // owner's save into an error.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    readyGoes(false, true);
    reloadMcp.mockResolvedValue(false);
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: true } }));
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(true);
    errorSpy.mockRestore();
  });

  it("still saves the switch when the reload throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    readyGoes(true, false);
    reloadMcp.mockRejectedValue(new Error("socket exploded"));
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: false } }));
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(false);
    errorSpy.mockRestore();
  });
});

/**
 * The paid-plan gate — owner's decision, 2026-09-14: the coding agent needs a
 * ClawBox Pro or Max plan.
 *
 * The tier names are off by one and always have been: the internal `flash` is
 * the plan marketed as **Pro** and the internal `pro` is **Max**. So both are
 * paid, and "Free" is either the portal's positive `free` word or no key at
 * all — a box nobody has connected.
 *
 * What is pinned here as hard as the refusal itself is its SHAPE: it refuses
 * only a body that would switch the feature ON or finish its wizard. A box
 * that was already enabled when the subscription lapsed is never auto-disabled
 * — that is the owner's own consent and their own runs — so its settings stay
 * writable, including the switch that turns it off.
 */
describe("the paid-plan gate", () => {
  const plan = (value: string | undefined) =>
    vi.mocked(configGet).mockImplementation(async (key: string) =>
      key === "clawai_plan_tier" ? value : undefined);

  for (const tier of ["flash", "pro"] as const) {
    it(`lets the switch through on the ${tier} plan`, async () => {
      plan(tier);
      const res = await POST(request({ cookie: ownerCookie(), body: { enabled: true } }));
      expect(res.status).toBe(200);
      expect(setEnabled).toHaveBeenCalledWith(true);
    });
  }

  for (const [name, value] of [["a free account", "free"], ["no account at all", undefined]] as const) {
    it(`refuses the switch with ${name}`, async () => {
      plan(value);
      const res = await POST(request({ cookie: ownerCookie(), body: { enabled: true } }));
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("paid_plan_required");
      expect(body.code).toBe("paid_plan_required");
      expect(body.feature).toBe("coding_agent");
      expect(body.plan).toBeNull();
      expect(setEnabled).not.toHaveBeenCalled();
    });
  }

  it("refuses the wizard's completion flag too", async () => {
    plan("free");
    const res = await POST(request({ cookie: ownerCookie(), body: { setupComplete: true } }));
    expect(res.status).toBe(402);
  });

  it("is checked BEFORE the owner check gives way — the bearer still gets 403", async () => {
    plan("free");
    const res = await POST(request({ bearer: "any-valid-looking-token-value", body: { enabled: true } }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
  });

  it("still lets an unpaid box switch itself off", async () => {
    plan("free");
    const res = await POST(request({ cookie: ownerCookie(), body: { enabled: false } }));
    expect(res.status).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith(false);
  });

  it("leaves the other settings of an unpaid box writable", async () => {
    plan("free");
    const res = await POST(request({ cookie: ownerCookie(), body: { effort: "low" } }));
    expect(res.status).toBe(200);
    expect(setEffort).toHaveBeenCalledWith("low");
  });
});

describe("a team's model and effort per role", () => {
  it("saves the owner's choice through the real validator", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { roleModels: { planner: { model: "standard", effort: "max" } } } }));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("coding_agent_role_models", { planner: { model: "standard", effort: "max" } });
  });

  it("puts a half back to the role's default with \"auto\"", async () => {
    vi.mocked(configGet).mockImplementation(async (key: string) =>
      key === "clawai_plan_tier" ? "flash" : key === "coding_agent_role_models" ? { planner: { model: "standard", effort: "max" } } : undefined);
    const res = await POST(request({ cookie: ownerCookie(), body: { roleModels: { planner: { model: "auto" } } } }));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("coding_agent_role_models", { planner: { effort: "max" } });
  });

  it("refuses an edit it does not understand BEFORE any setting in the same body is written", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { effort: "low", roleModels: { planner: { model: "cheapest" } } } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.kind).toBe("invalid");
    expect(body.error).toMatch(/roleModels\.planner\.model/);
    expect(setEffort).not.toHaveBeenCalled();
    expect(configSet).not.toHaveBeenCalled();
  });

  it("saves the connected providers, moves the default onto the list, and puts a role pinned to a dropped account back on Default", async () => {
    vi.mocked(configGet).mockImplementation(async (key: string) =>
      key === "clawai_plan_tier" ? "flash"
        : key === "coding_agent_provider" ? "anthropic"
          : key === "coding_agent_role_models" ? { planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "high" }, reviewer: { provider: "anthropic", model: "economy" }, worker: { provider: "clawbox-ai" } }
            : undefined);
    const res = await POST(request({ cookie: ownerCookie(), body: { providers: ["clawbox-ai"] } }));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("coding_agent_providers", ["clawbox-ai"]);
    // The default provider was anthropic, which just left the list.
    expect(configSet).toHaveBeenCalledWith("coding_agent_provider", "clawbox-ai");
    // The planner loses its account AND the model only that account offered; the reviewer keeps its tier; the worker is untouched.
    expect(configSet).toHaveBeenCalledWith("coding_agent_role_models", { planner: { effort: "high" }, reviewer: { model: "economy" }, worker: { provider: "clawbox-ai" } });
  });

  it("applies the list before the default, and refuses a default outside the resulting list before any write", async () => {
    const both = await POST(request({ cookie: ownerCookie(), body: { providers: ["clawbox-ai", "anthropic"], provider: "anthropic" } }));
    expect(both.status).toBe(200);
    const order = vi.mocked(configSet).mock.calls.map(([key]) => key);
    expect(order.indexOf("coding_agent_providers")).toBeLessThan(order.lastIndexOf("coding_agent_provider"));
    expect(configSet).toHaveBeenCalledWith("coding_agent_provider", "anthropic");
    vi.mocked(configSet).mockClear();

    const outside = await POST(request({ cookie: ownerCookie(), body: { providers: ["clawbox-ai"], provider: "anthropic" } }));
    expect(outside.status).toBe(400);
    expect((await outside.json()).error).toMatch(/connected/);
    expect(configSet).not.toHaveBeenCalled();

    // A default alone must be connected too: the stored list (the default alone, on a record from before the list) does not carry it.
    const alone = await POST(request({ cookie: ownerCookie(), body: { provider: "anthropic" } }));
    expect(alone.status).toBe(400);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("refuses an empty connected list and an unknown provider, before anything is written", async () => {
    const empty = await POST(request({ cookie: ownerCookie(), body: { providers: [] } }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/at least one provider/i);
    const unknown = await POST(request({ cookie: ownerCookie(), body: { providers: ["clawbox-ai", "mistral"] } }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).kind).toBe("invalid");
    expect(configSet).not.toHaveBeenCalled();
  });

  it("saves a provider and a model per role", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { roleModels: {
      planner: { provider: "anthropic", model: "claude-fable-5-1" },
      reviewer: { provider: "clawbox-ai", model: "deepseek-v4-flash" },
    } } }));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("coding_agent_role_models", {
      planner: { provider: "anthropic", model: "claude-fable-5-1" },
      reviewer: { provider: "clawbox-ai", model: "deepseek-v4-flash" },
    });
  });

  it("takes a model named alone against the provider already stored for the role", async () => {
    vi.mocked(configGet).mockImplementation(async (key: string) =>
      key === "clawai_plan_tier" ? "flash" : key === "coding_agent_role_models" ? { planner: { provider: "anthropic", effort: "high" } } : undefined);
    const res = await POST(request({ cookie: ownerCookie(), body: { roleModels: { planner: { model: "claude-sonnet-5" } } } }));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("coding_agent_role_models", { planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "high" } });
  });

  it("refuses a provider and model that do not go together, WHOLE and before anything is written", async () => {
    for (const roleModels of [
      { planner: { provider: "clawbox-ai", model: "claude-fable-5-1" } },
      { reviewer: { provider: "clawbox-ai", model: "deepseek-v4-pro" } },
      // A role until 2026-10-30, unknown since.
      { bulk: { provider: "clawbox-ai" } },
      { worker: { model: "claude-fable-5-1" } },
      { planner: { provider: "anthropic", model: "claude-fable-5-1" }, reviewer: { provider: "mistral" } },
      { reviewer: { provider: "openai", model: "claude-sonnet-5" } },
    ]) {
      const res = await POST(request({ cookie: ownerCookie(), body: { effort: "low", roleModels } }));
      expect(res.status, JSON.stringify(roleModels)).toBe(400);
      expect((await res.json()).kind).toBe("invalid");
    }
    expect(setEffort).not.toHaveBeenCalled();
    expect(configSet).not.toHaveBeenCalled();
  });

  it("names the new shape in its usage answer", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { nothing: true } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("{ roleModels: { planner?|worker?|reviewer?: { provider?, model?, effort? } } }");
  });

  it("is the owner's alone: the MCP bearer cannot change what a team's runs cost", async () => {
    const res = await POST(request({ bearer: "any-valid-looking-token-value", body: { roleModels: { worker: { model: "economy" } } } }));
    expect(res.status).toBe(403);
    expect(configSet).not.toHaveBeenCalled();
  });
});
