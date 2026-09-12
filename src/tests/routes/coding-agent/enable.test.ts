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
const setGenerateImages = vi.hoisted(() => vi.fn());
const setGenerateAudio = vi.hoisted(() => vi.fn());
const setRealBrowser = vi.hoisted(() => vi.fn());
const clearHarnessFault = vi.hoisted(() => vi.fn());
const setAutoMerge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coding-agent")>()),
  setCodingAgentEnabled: setEnabled,
  getCodingAgentStatus: getStatus,
  setEffort,
  setGenerateImages,
  setGenerateAudio,
  setRealBrowser,
  clearHarnessFault,
  // setReviewRounds is deliberately left REAL: its range refusal is the thing
  // under test below, and a mock would pin the route's plumbing instead.
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

import { get as configGet, set as configSet } from "@/lib/config-store";

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
  vi.mocked(configGet).mockImplementation(async () => undefined);
  getStatus.mockResolvedValue(STATUS);
  setEnabled.mockResolvedValue(undefined);
  reloadMcp.mockResolvedValue(true);
  setEffort.mockResolvedValue("low");
  setGenerateImages.mockResolvedValue(false);
  setGenerateAudio.mockResolvedValue(false);
  setRealBrowser.mockResolvedValue(false);
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

  it("takes the two media switches, and names them in the refusal when a body carries nothing it knows", async () => {
    const images = await POST(request({ cookie: ownerCookie(), body: { generateImages: false } }));
    expect(images.status).toBe(200);
    expect(setGenerateImages).toHaveBeenCalledWith(false);
    const audio = await POST(request({ cookie: ownerCookie(), body: { generateAudio: true } }));
    expect(audio.status).toBe(200);
    expect(setGenerateAudio).toHaveBeenCalledWith(true);
    // A body with none of the route's fields has to say which fields exist, or
    // the caller is left guessing at the one that was misspelled.
    const empty = await POST(request({ cookie: ownerCookie(), body: { nonsense: 1 } }));
    expect(empty.status).toBe(400);
    const message = (await empty.json()).error as string;
    expect(message).toContain("{ generateImages: boolean }");
    expect(message).toContain("{ generateAudio: boolean }");
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

  it("takes the review-loop settings, and names them in the refusal too", async () => {
    const rounds = await POST(request({ cookie: ownerCookie(), body: { reviewRounds: 5 } }));
    expect(rounds.status).toBe(200);
    const merge = await POST(request({ cookie: ownerCookie(), body: { autoMerge: true } }));
    expect(merge.status).toBe(200);
    expect(setAutoMerge).toHaveBeenCalledWith(true);

    const empty = await POST(request({ cookie: ownerCookie(), body: { nonsense: 1 } }));
    const message = (await empty.json()).error as string;
    expect(message).toContain("{ reviewRounds: number }");
    expect(message).toContain("{ autoMerge: boolean }");
  });

  it("takes 0 rounds — the loop switched off is a setting, not an empty body", async () => {
    // `!fields.reviewRounds` would read 0 as "this request is not about the
    // rounds" and answer 400 for the one value that switches the loop off.
    const res = await POST(request({ cookie: ownerCookie(), body: { reviewRounds: 0 } }));
    expect(res.status).toBe(200);
  });

  it("REFUSES a round count outside the range rather than clamping it", async () => {
    // A caller that asked for 20 meant something this box does not offer, and
    // silently saving 6 would answer a question it did not ask.
    for (const bad of [-1, 7, 100]) {
      const res = await POST(request({ cookie: ownerCookie(), body: { reviewRounds: bad } }));
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json()).error as string).toContain("between 0 and 6");
    }
  });

  it("REFUSES a fractional round count rather than rounding it into one", async () => {
    // `clampReviewRounds` rounds, so 1.5 would have been SAVED as 2 — an
    // answer to a question the caller did not ask.
    for (const bad of [1.5, 0.5, 2.0001]) {
      const res = await POST(request({ cookie: ownerCookie(), body: { reviewRounds: bad } }));
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json()).error as string).toContain("whole number");
    }
  });

  /**
   * How many goes a run with a deliverable gets at it.
   *
   * `setCompletionAttempts` is deliberately left REAL in this file's mocks, like
   * `setReviewRounds`: the range refusal is the thing under test, and a mock
   * would pin the route's plumbing rather than what a caller is actually told.
   */
  it("takes the attempt count, and names it in the refusal too", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { completionAttempts: 5 } }));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("coding_agent_completion_attempts", 5);

    const empty = await POST(request({ cookie: ownerCookie(), body: { nonsense: 1 } }));
    expect((await empty.json()).error as string).toContain("{ completionAttempts: number }");
  });

  it("takes 1 — check it and spend nothing more is a real setting", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { completionAttempts: 1 } }));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith("coding_agent_completion_attempts", 1);
  });

  it("REFUSES an attempt count outside the range, and a fractional one", async () => {
    // Refused rather than clamped, the rule the rounds above follow: a caller
    // that asked for 20 meant something this box does not offer.
    for (const bad of [0, -1, 7, 100]) {
      const res = await POST(request({ cookie: ownerCookie(), body: { completionAttempts: bad } }));
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json()).error as string).toContain("between 1 and 6");
    }
    for (const bad of [1.5, 2.0001]) {
      const res = await POST(request({ cookie: ownerCookie(), body: { completionAttempts: bad } }));
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json()).error as string).toContain("whole number");
    }
  });

  it("refuses the AGENT the attempt count, like every other setting here", async () => {
    const res = await POST(request({ bearer: "any-valid-looking-token-value", body: { completionAttempts: 6 } }));
    expect(res.status).toBe(403);
    expect(configSet).not.toHaveBeenCalled();
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
    // The media switches are read per RUN, at spawn, so they move no tool on
    // the assistant's own long-lived server either.
    await POST(request({ cookie: ownerCookie(), body: { generateImages: false } }));
    await POST(request({ cookie: ownerCookie(), body: { generateAudio: false } }));
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
