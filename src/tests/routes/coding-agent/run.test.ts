/**
 * POST /setup-api/coding-agent/run — starting a run.
 *
 * Pins the status vocabulary the MCP layer depends on: 409 (never 403 or 500)
 * while the owner's switch is off or the harness is busy, because
 * mcp/lib/errors.ts maps 409 to CONFLICT / do-not-retry and everything else
 * to "the device needs a restart" or "retry once". Also that the route is
 * gated in-handler (a 401 without a session, no first-boot carve-out), that
 * it answers 202 at once rather than waiting for the run, and that it labels
 * who asked — the owner's cookie or the agent's bearer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

const startRun = vi.hoisted(() => vi.fn());
// The route starts through the queue (startOrQueueRun); a start it does not
// queue is the start the cases below script on `startRun`.
const startOrQueueRun = vi.hoisted(() => vi.fn());
// The owner's default time budget: none unless a case sets one.
const getDefaultTimeBudget = vi.hoisted(() => vi.fn());
// The owner's token cap: a long budget's default spend ceiling. None unless a case sets one.
const getTokenLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/coding-agent")>("@/lib/coding-agent");
  return { ...actual, startRun, startOrQueueRun, getDefaultTimeBudget, getTokenLimit };
});
// A budget over 30 minutes starts a TEAM instead of the run.
const startTeam = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-team", () => ({ startTeam }));
// The box's zone, pinned so a deadline does not depend on the machine.
vi.mock("@/lib/timezone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/timezone")>()),
  readOsTimeZone: vi.fn(async () => "Europe/Sofia"),
}));

const MCP_TOKEN = "mcp-bearer-token-for-the-agent-0123456789";

let POST: (req: Request) => Promise<Response>;
let CodingAgentError: typeof import("@/lib/coding-agent").CodingAgentError;
let ProviderChoiceError: typeof import("@/lib/coding-agent").ProviderChoiceError;
let MAX_TASK_CHARS: number;
let session: SessionFixture;
let restore: () => void;

const RUN = { id: "run-k3x9q2ab", status: "running", directory: "/home/clawbox/clawbox/data/code-projects/site", projectId: "site" };
const TEAM = { id: "team-abcd1234", goal: "g", source: "owner", status: "planning", tasks: [], log: [] };

function req(init: { auth?: "cookie" | "bearer" | "none"; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const auth = init.auth ?? "cookie";
  if (auth === "cookie") headers.Cookie = session.cookie;
  if (auth === "bearer") headers.Authorization = `Bearer ${MCP_TOKEN}`;
  return new Request("http://localhost/setup-api/coding-agent/run", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? { task: "Add a dark mode toggle", projectId: "site" }),
  });
}

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_MCP_TOKEN");
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  session = installSessionFixture();
  vi.resetModules();
  vi.clearAllMocks();
  startRun.mockResolvedValue(RUN);
  startOrQueueRun.mockImplementation(async (input: unknown) => ({ run: await startRun(input), queued: false }));
  getDefaultTimeBudget.mockResolvedValue(null);
  getTokenLimit.mockResolvedValue(null);
  startTeam.mockResolvedValue(TEAM);
  const lib = await import("@/lib/coding-agent");
  CodingAgentError = lib.CodingAgentError;
  ProviderChoiceError = lib.ProviderChoiceError;
  MAX_TASK_CHARS = lib.MAX_TASK_CHARS;
  const route = await import("@/app/setup-api/coding-agent/run/route");
  POST = route.POST;
});

afterEach(() => {
  session.cleanup();
  restore();
});

describe("the gate", () => {
  it("is 401 without a session, and starts nothing", async () => {
    const res = await POST(req({ auth: "none" }));
    expect(res.status).toBe(401);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("is 401 during the first-boot window too — there is no bootstrap carve-out", async () => {
    session.cleanup();
    session = installSessionFixture({ passwordConfigured: false });
    const res = await POST(req({ auth: "none" }));
    expect(res.status).toBe(401);
  });

  it("accepts the agent's bearer and labels the run as the agent's", async () => {
    const res = await POST(req({ auth: "bearer" }));
    expect(res.status).toBe(202);
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ source: "agent", projectId: "site" }));
  });

  it("labels a run started from the owner's browser as the owner's", async () => {
    const res = await POST(req({ auth: "cookie" }));
    expect(res.status).toBe(202);
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ source: "owner" }));
  });
});

describe("the answer", () => {
  it("is 202 with the run record, at once", async () => {
    const res = await POST(req());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true, queued: false, run: RUN });
  });

  it("passes the folder and resume id through untouched", async () => {
    await POST(req({ body: { task: "t", directory: "/home/clawbox/projects/x", resumeRunId: "run-aaaaaaaa" } }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      task: "t", directory: "/home/clawbox/projects/x", resumeRunId: "run-aaaaaaaa", projectId: null,
    }));
  });
});

describe("refusals the agent must be able to tell apart", () => {
  it("answers 409 with the kind while the switch is off", async () => {
    startRun.mockRejectedValue(new CodingAgentError("disabled", "switched off"));
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "switched off", kind: "disabled" });
  });

  it("answers 409 when the harness is not ready or busy", async () => {
    startRun.mockRejectedValueOnce(new CodingAgentError("not_ready", "no token"));
    expect((await POST(req())).status).toBe(409);
    startRun.mockRejectedValueOnce(new CodingAgentError("busy", "one already"));
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("busy");
  });

  it("answers 404 for a missing project and 400 for a bad folder", async () => {
    startRun.mockRejectedValueOnce(new CodingAgentError("not_found", "no project"));
    expect((await POST(req())).status).toBe(404);
    startRun.mockRejectedValueOnce(new CodingAgentError("invalid", "outside home"));
    expect((await POST(req())).status).toBe(400);
  });

  it("rejects an empty task and an oversized one before touching the runner", async () => {
    expect((await POST(req({ body: { task: "   ", projectId: "site" } }))).status).toBe(400);
    expect((await POST(req({ body: { task: "x".repeat(MAX_TASK_CHARS + 1), projectId: "site" } }))).status).toBe(413);
    expect((await POST(req({ raw: "nope" }))).status).toBe(400);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("turns an unexpected failure into a 500 with a plain message", async () => {
    startRun.mockRejectedValue(new Error("spawn EACCES"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("spawn EACCES");
  });
});

/**
 * WHICH ACCOUNT PAYS. The route does not decide — `startRun` does, from the
 * owner's stored default — so what is pinned here is that a caller's choice
 * arrives UNTOUCHED (a route that coerced it would be a second, quieter
 * validator beside src/lib/coding-provider.ts) and that the refusals keep the
 * status codes the MCP layer reads.
 */
describe("provider and model", () => {
  it("passes both through exactly as the caller sent them", async () => {
    await POST(req({ body: { task: "Do the thing", projectId: "site", provider: "anthropic", model: "claude-sonnet-5" } }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-5" }));
  });

  it("passes `undefined` when the caller named neither, so the owner's default stands", async () => {
    // NOT a default invented here: this process would be guessing, and a
    // guess that disagreed with the stored setting would silently move a run
    // onto the wrong bill.
    await POST(req());
    const input = startRun.mock.calls[0][0] as { provider?: unknown; model?: unknown };
    expect(input.provider).toBeUndefined();
    expect(input.model).toBeUndefined();
  });

  it("hands a junk provider to the runner rather than filtering it out", async () => {
    // The refusal belongs to the one validator. Dropping the field here would
    // turn "that provider does not exist" into a run on the default — the
    // caller's mistake, silently honoured as something else.
    await POST(req({ body: { task: "t", projectId: "site", provider: "openai" } }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai" }));
  });

  it("answers 400 when the runner refuses the pair", async () => {
    startRun.mockRejectedValueOnce(new CodingAgentError("invalid", "Unknown provider. Use one of: clawbox-ai, anthropic."));
    const res = await POST(req({ body: { task: "t", projectId: "site", provider: "openai" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/clawbox-ai, anthropic/);
  });

  it("marks a refused pair with a code, so a caller can tell it from a refused folder", async () => {
    // Both are 400 `kind: "invalid"`, and they want opposite advice: the folder
    // refusal says "use another folder", the pair refusal says "leave the
    // folder alone". Without the code the MCP tool gave the folder advice to a
    // caller whose folder was fine.
    startRun.mockRejectedValueOnce(new ProviderChoiceError('ClawBox AI chooses its own model; name a model only with the "anthropic" provider.'));
    const res = await POST(req({ body: { task: "t", projectId: "site", model: "claude-opus-5" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.kind).toBe("invalid");
    expect(body.code).toBe("provider");
  });

  it("leaves a folder refusal without a code", async () => {
    startRun.mockRejectedValueOnce(new CodingAgentError("invalid", "That folder holds credentials."));
    const res = await POST(req({ body: { task: "t", directory: "/home/clawbox/clawbox/data" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).not.toHaveProperty("code");
  });

  it("answers 409 — never 403 or 500 — when that account is not connected", async () => {
    // mcp/lib/errors.ts maps 409 to CONFLICT / do-not-retry. Anything else
    // reads as "the device needs a restart", and the agent retries a refusal
    // only the owner can clear.
    startRun.mockRejectedValueOnce(new CodingAgentError("not_ready", "Your Anthropic account is not connected."));
    const res = await POST(req({ body: { task: "t", projectId: "site", provider: "anthropic" } }));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("not_ready");
  });
});

/**
 * The deliverable the caller may set.
 *
 * The route's whole job here is to hand the field to the ONE reader and to say
 * WHO asked — the owner's cookie or the agent's bearer — because that is what
 * decides whether a `command` deliverable is allowed. A route that validated
 * the deliverable itself would be a second opinion beside the draft route's.
 */
describe("the deliverable", () => {
  it("passes it through untouched, so one reader judges it", async () => {
    await POST(req({ body: { task: "t", projectId: "site", deliverable: { kind: "paths", paths: ["app.js"] } } }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      deliverable: { kind: "paths", paths: ["app.js"] },
      source: "owner",
    }));
  });

  it("labels a BEARER caller as the agent, which is what refuses a command", async () => {
    // `source` is derived from the owner's cookie and never from the body, so a
    // caller cannot declare itself the owner to get a command deliverable.
    await POST(req({ auth: "bearer", body: { task: "t", projectId: "site", deliverable: { kind: "command", command: "true" }, source: "owner" } }));
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ source: "agent" }));
  });

  it("carries the runner's own reason through as a 400 when it refuses one", async () => {
    // The reason is the actionable half: "only the owner can set a command
    // deliverable" and "that path is not relative" need different fixes, and a
    // bare "the device rejected an argument" tells the caller neither.
    startRun.mockRejectedValueOnce(new CodingAgentError("invalid", "Only the owner can set a command deliverable."));
    const res = await POST(req({ auth: "bearer", body: { task: "t", projectId: "site", deliverable: { kind: "command", command: "true" } } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Only the owner can set a command deliverable.", kind: "invalid" });
  });

  it("sends no deliverable at all when the body names none", async () => {
    await POST(req({ body: { task: "t", projectId: "site" } }));
    expect(startRun.mock.calls[0][0].deliverable).toBeUndefined();
  });
});

describe("the files a run is given", () => {
  it("hands the caller's paths to startRun untouched, so one reader decides what this box copies", async () => {
    const paths = ["/home/clawbox/.openclaw/media/tool-image-generation/a.png", "/nowhere/b.png"];
    const res = await POST(req({ auth: "bearer", body: { task: "Use these four pictures", projectId: "site", inputs: paths } }));
    expect(res.status).toBe(202);
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({ inputs: paths }));
  });

  it("sends nothing when the caller named nothing, so an absent list stays absent", async () => {
    await POST(req({ body: { task: "Add a dark mode toggle", projectId: "site" } }));
    expect(startRun.mock.calls[0][0].inputs).toBeUndefined();
  });
});

describe("a run beyond the limit", () => {
  it("is QUEUED, not refused: 202 with the queued record and its place, for the bearer as for the owner", async () => {
    const queuedRun = { ...RUN, status: "queued", queued: { at: 1, position: 2 } };
    startOrQueueRun.mockResolvedValueOnce({ run: queuedRun, queued: true });
    const res = await POST(req({ auth: "bearer" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: false, queued: true, run: queuedRun });
    expect(startOrQueueRun).toHaveBeenCalledWith(expect.objectContaining({ source: "agent" }));
  });

  it("answers a start that was not queued as it always did", async () => {
    expect(await (await POST(req())).json()).toEqual({ started: true, queued: false, run: RUN });
  });
});

describe("a Fix CI continuation", () => {
  it("passes fixCi through only as true — what failed is the box's to append", async () => {
    await POST(req({ body: { task: "Fix the failing CI checks.", resumeRunId: "run-k3x9q2ab", fixCi: true } }));
    expect(startOrQueueRun).toHaveBeenLastCalledWith(expect.objectContaining({ resumeRunId: "run-k3x9q2ab", fixCi: true }));
    await POST(req({ body: { task: "Carry on.", resumeRunId: "run-k3x9q2ab", fixCi: "yes" } }));
    expect(startOrQueueRun.mock.calls[startOrQueueRun.mock.calls.length - 1][0]).not.toHaveProperty("fixCi");
  });
});

/**
 * THE TIME BUDGET (src/lib/coding-time-budget.ts). The route resolves it — the
 * picker's `budget`, else the task's words, else the owner's default — on the
 * box's clock, and decides from it whether this is one run or a team: over 30
 * minutes is a team. Without one, nothing about the run or the answer moves.
 */
describe("the time budget", () => {
  const MIN = 60_000;
  const span = (b: { deadline: string; setAt: string }) => Date.parse(b.deadline) - Date.parse(b.setAt);
  const lastRunInput = () => startOrQueueRun.mock.calls[startOrQueueRun.mock.calls.length - 1][0] as Record<string, unknown>;

  it("leaves a run without one exactly as it was: no field on the input, none on the answer", async () => {
    const res = await POST(req({ body: { task: "Add a dark mode toggle", projectId: "site" } }));
    expect(await res.json()).toEqual({ started: true, queued: false, run: RUN });
    expect(lastRunInput()).not.toHaveProperty("timeBudget");
    expect(startTeam).not.toHaveBeenCalled();
  });

  it("keeps 30 minutes on one run, frozen on its input and named in the answer", async () => {
    const res = await POST(req({ body: { task: "Add a dark mode toggle", projectId: "site", budget: "30m" } }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ started: true, queued: false, run: RUN, timeBudget: { preset: "30m", source: "picker", label: "30 minutes" } });
    expect(body).not.toHaveProperty("routedToTeam");
    expect(span(body.timeBudget)).toBe(30 * MIN);
    expect(lastRunInput().timeBudget).toEqual(body.timeBudget);
    expect(startTeam).not.toHaveBeenCalled();
  });

  it("starts a TEAM for a budget over 30 minutes, with the task as its goal and the budget on its board", async () => {
    const res = await POST(req({ body: { task: "Build the invoice app", projectId: "site", budget: "1h" } }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ started: true, queued: false, team: TEAM, routedToTeam: true, timeBudget: { preset: "1h" } });
    expect(body).not.toHaveProperty("run");
    expect(startTeam).toHaveBeenCalledWith({
      goal: "Build the invoice app", projectId: "site", directory: null, source: "owner", timeBudget: body.timeBudget,
    });
    expect(startOrQueueRun).not.toHaveBeenCalled();
  });

  it("labels the team the agent's when the bearer asked, and answers a queued team as queued", async () => {
    startTeam.mockResolvedValueOnce({ ...TEAM, source: "agent", status: "queued", queuePosition: 1 });
    const res = await POST(req({ auth: "bearer", body: { task: "Build it", directory: "/home/clawbox/projects/x", budget: "morning" } }));
    expect(await res.json()).toMatchObject({ started: false, queued: true, routedToTeam: true, team: { status: "queued" }, timeBudget: { preset: "morning" } });
    expect(startTeam).toHaveBeenCalledWith(expect.objectContaining({ source: "agent", directory: "/home/clawbox/projects/x" }));
  });

  it("reads the budget from the task's words when the picker named none", async () => {
    const res = await POST(req({ body: { task: "You have 2 hours: build the invoice app", projectId: "site" } }));
    const body = await res.json();
    expect(body).toMatchObject({ routedToTeam: true, timeBudget: { source: "text", label: "2 hours" } });
    expect(span(body.timeBudget)).toBe(120 * MIN);
    const short = await (await POST(req({ body: { task: "Fix the typo. You have 30 minutes.", projectId: "site" } }))).json();
    expect(short).toMatchObject({ run: RUN, timeBudget: { source: "text", preset: "30m" } });
  });

  it("lets the picker beat the words, and \"none\" beat both the words and the default", async () => {
    getDefaultTimeBudget.mockResolvedValue("1d");
    const picked = await (await POST(req({ body: { task: "You have 2 hours", projectId: "site", budget: "30m" } }))).json();
    expect(picked).toMatchObject({ run: RUN, timeBudget: { preset: "30m", source: "picker" } });
    const none = await (await POST(req({ body: { task: "You have 2 hours", projectId: "site", budget: "none" } }))).json();
    expect(none).toEqual({ started: true, queued: false, run: RUN });
    expect(lastRunInput()).not.toHaveProperty("timeBudget");
    expect(startTeam).not.toHaveBeenCalled();
  });

  it("falls back to the owner's default — and routes it like any other budget", async () => {
    getDefaultTimeBudget.mockResolvedValue("1h");
    const body = await (await POST(req({ body: { task: "Build the invoice app", projectId: "site" } }))).json();
    expect(body).toMatchObject({ routedToTeam: true, timeBudget: { preset: "1h", source: "default" } });
    getDefaultTimeBudget.mockResolvedValue("30m");
    const short = await (await POST(req({ body: { task: "Fix the typo", projectId: "site" } }))).json();
    expect(short).toMatchObject({ run: RUN, timeBudget: { preset: "30m", source: "default" } });
  });

  it("never routes a resume or a Fix CI to a team, and never hands them the owner's default", async () => {
    getDefaultTimeBudget.mockResolvedValue("1d");
    const resumed = await (await POST(req({ body: { task: "Carry on", resumeRunId: "run-aaaaaaaa" } }))).json();
    expect(resumed).toEqual({ started: true, queued: false, run: RUN });
    expect(lastRunInput()).not.toHaveProperty("timeBudget");
    // A budget it is GIVEN stays with the run it continues.
    const given = await (await POST(req({ body: { task: "Carry on", resumeRunId: "run-aaaaaaaa", budget: "2h" } }))).json();
    expect(given).toMatchObject({ run: RUN, timeBudget: { label: "2 hours" } });
    expect(given).not.toHaveProperty("routedToTeam");
    expect(lastRunInput()).toMatchObject({ resumeRunId: "run-aaaaaaaa", timeBudget: given.timeBudget });
    await POST(req({ body: { task: "Fix the failing CI checks.", resumeRunId: "run-k3x9q2ab", fixCi: true } }));
    expect(lastRunInput()).not.toHaveProperty("timeBudget");
    expect(startTeam).not.toHaveBeenCalled();
  });

  it("keeps a long budget on one run when the request carries what only a run can, and says why", async () => {
    const res = await POST(req({ auth: "bearer", body: { task: "Use these pictures", projectId: "site", budget: "2h", inputs: ["/tmp/a.png"] } }));
    const body = await res.json();
    expect(body).toMatchObject({ run: RUN, routedToTeam: false, timeBudget: { label: "2 hours" } });
    expect(body.routeNote).toMatch(/inputs/);
    expect(lastRunInput()).toMatchObject({ inputs: ["/tmp/a.png"], timeBudget: body.timeBudget });
    expect(startTeam).not.toHaveBeenCalled();
    // An empty list asks for nothing, so it does not hold the team back.
    await POST(req({ body: { task: "Build it", projectId: "site", budget: "2h", inputs: [] } }));
    expect(startTeam).toHaveBeenCalledTimes(1);
  });

  it("refuses a budget it cannot read, one in the past and one too far away — 400 with a sentence, nothing started", async () => {
    for (const budget of ["whenever", "2026-01-01T10:00:00Z", "30d", 42, { preset: "fortnight" }]) {
      const res = await POST(req({ body: { task: "Build it", projectId: "site", budget } }));
      expect(res.status, JSON.stringify(budget)).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ kind: "invalid", code: "budget" });
      expect(body.error).toMatch(/time budget/);
    }
    expect(startOrQueueRun).not.toHaveBeenCalled();
    expect(startTeam).not.toHaveBeenCalled();
  });

  it("takes a custom period from the calendar", async () => {
    const end = new Date(Date.now() + 3 * 60 * MIN).toISOString();
    const body = await (await POST(req({ body: { task: "Build it", projectId: "site", budget: { preset: "custom", end } } }))).json();
    expect(body).toMatchObject({ routedToTeam: true, timeBudget: { preset: "custom", source: "picker", deadline: end } });
  });

  it("says when the words named a budget it would not take, and starts without it", async () => {
    const body = await (await POST(req({ body: { task: "Work for 20 days on the rewrite", projectId: "site" } }))).json();
    expect(body).toMatchObject({ run: RUN, timeBudgetIgnored: { phrase: "Work for 20 days", error: expect.stringMatching(/14 days/) } });
    expect(body).not.toHaveProperty("timeBudget");
    expect(lastRunInput()).not.toHaveProperty("timeBudget");
  });

  it("passes the team's refusals through with their status", async () => {
    startTeam.mockRejectedValueOnce(new CodingAgentError("busy", "There are already 3 coding teams waiting."));
    const res = await POST(req({ body: { task: "Build it", projectId: "site", budget: "1d" } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "There are already 3 coding teams waiting.", kind: "busy" });
  });

  it("gives a budget over two hours the owner's token cap as its spend ceiling, and takes one named with it", async () => {
    getTokenLimit.mockResolvedValue(500_000);
    const day = await (await POST(req({ body: { task: "Build it", projectId: "site", budget: "1d" } }))).json();
    expect(day.timeBudget).toMatchObject({ preset: "1d", tokenCap: 500_000 });
    expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({ timeBudget: day.timeBudget }));
    const hour = await (await POST(req({ body: { task: "Build it", projectId: "site", budget: "1h" } }))).json();
    expect(hour.timeBudget).not.toHaveProperty("tokenCap");
    const named = await (await POST(req({ body: { task: "Build it", projectId: "site", budget: { preset: "1d", tokenCap: 50_000 } } }))).json();
    expect(named.timeBudget.tokenCap).toBe(50_000);
    const bad = await POST(req({ body: { task: "Build it", projectId: "site", budget: { preset: "1d", tokenCap: 5 } } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "budget", error: expect.stringMatching(/token ceiling/) });
  });
});
