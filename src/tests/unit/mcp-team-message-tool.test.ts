/**
 * `team_message` (mcp/tools/coding-agent.ts) and the run context that decides
 * whether it exists (mcp/lib/run-context.ts).
 *
 *   - The team context is all-or-nothing, like the run pair it sits on: the
 *     four variables the runner sets for a team's run, each in the shape the
 *     runner writes, inside a run — anything less is no team, and the tool is
 *     simply not registered (never registered-and-refusing).
 *   - The tool speaks as THIS run: team, run and role come from the
 *     environment, never from the model's arguments.
 *   - Every refusal the route answers comes back with its own code leading the
 *     message and a next step that does not invite a retry loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "../helpers/env";
import { captureRegistrar, type CaptureHarness } from "../helpers/mcp-registrar";
import { ApiError } from "../../../mcp/lib/errors";
import { teamRunContext } from "../../../mcp/lib/run-context";
import { registerTeamRunTools, TEAM_MESSAGE_CALL_TIMEOUT_MS } from "../../../mcp/tools/coding-agent";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock("../../../mcp/lib/api", () => ({
  apiPost,
  apiGet: vi.fn(),
  apiTry: async () => null,
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

const VARS = ["CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR", "CLAWBOX_RUN_ID", "CLAWBOX_TEAM_ID", "CLAWBOX_TEAM_ROLE", "CLAWBOX_TEAM_TASK"] as const;
const TEAM_ENV = {
  CLAWBOX_RUN_DIR: "/home/clawbox/Projects/shop/.clawbox/worktrees/t1-1",
  CLAWBOX_RUN_ARTIFACTS_DIR: "/home/clawbox/clawbox/data/coding-agent-artifacts/run-ab12cd34",
  CLAWBOX_RUN_ID: "run-ab12cd34",
  CLAWBOX_TEAM_ID: "team-k3x9q2ab",
  CLAWBOX_TEAM_ROLE: "worker",
  CLAWBOX_TEAM_TASK: "t1",
};
let restore: () => void;

beforeEach(() => {
  restore = saveEnv(...VARS);
  for (const key of VARS) delete process.env[key];
  Object.assign(process.env, TEAM_ENV);
  apiPost.mockReset();
  apiPost.mockResolvedValue({ sent: true, to: "lead", toRunId: null, delivered: true, left: 11 });
});

afterEach(() => restore());

function teamTools(edition: "openclaw" | "hermes" = "openclaw"): CaptureHarness {
  const h = captureRegistrar(edition);
  registerTeamRunTools(h.reg);
  return h;
}

function refusalBody(code: string, error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error, code, ...extra });
}

describe("the team run context", () => {
  it("reads all four variables, inside a run, the planner's task as none", () => {
    expect(teamRunContext()).toEqual({ runId: "run-ab12cd34", teamId: "team-k3x9q2ab", role: "worker", taskId: "t1" });
    process.env.CLAWBOX_TEAM_ROLE = "planner";
    process.env.CLAWBOX_TEAM_TASK = "none";
    expect(teamRunContext()).toEqual({ runId: "run-ab12cd34", teamId: "team-k3x9q2ab", role: "planner", taskId: null });
  });

  it.each(["CLAWBOX_RUN_ID", "CLAWBOX_TEAM_ID", "CLAWBOX_TEAM_ROLE", "CLAWBOX_TEAM_TASK"])("is no team at all without %s", (key) => {
    delete process.env[key];
    expect(teamRunContext()).toBeNull();
  });

  it.each([
    ["CLAWBOX_RUN_ID", "run-../etc"],
    ["CLAWBOX_TEAM_ID", "team-1"],
    ["CLAWBOX_TEAM_ROLE", "lead"],
    ["CLAWBOX_TEAM_TASK", "t01"],
    ["CLAWBOX_TEAM_TASK", ""],
  ])("is no team at all when %s is %j", (key, value) => {
    process.env[key] = value;
    expect(teamRunContext()).toBeNull();
  });

  it("is no team outside a run, whatever the team variables say", () => {
    delete process.env.CLAWBOX_RUN_ARTIFACTS_DIR;
    expect(teamRunContext()).toBeNull();
  });
});

describe("when the tool exists", () => {
  it("registers team_message in a team's run, on both editions, in the run profile's family", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const tools = teamTools(edition);
      expect(tools.names()).toEqual(["team_message"]);
      expect(tools.get("team_message").opts).toMatchObject({ family: "browser", readOnly: false });
    }
  });

  it("registers nothing for a run that is not a team's, or outside any run", () => {
    delete process.env.CLAWBOX_TEAM_ID;
    expect(teamTools().names()).toEqual([]);
    Object.assign(process.env, TEAM_ENV);
    delete process.env.CLAWBOX_RUN_DIR;
    expect(teamTools().names()).toEqual([]);
  });

  it("says in its description when to use it, and that a received message needs no reply", () => {
    const { description } = teamTools().get("team_message");
    expect(description).toMatch(/blocked/);
    expect(description).toMatch(/never to acknowledge a message you received/i);
    expect(description).toMatch(/1500 characters; 4 per 5 minutes and 12 per run/);
    expect(description.length).toBeLessThanOrEqual(1000);
  });
});

describe("what it sends", () => {
  it("speaks as this run — team, run and role from the environment, never from the arguments", async () => {
    const out = await teamTools().call("team_message", { to: "lead", text: "The task names src/cart.ts and there is no src/." });
    expect(out.isError).toBe(false);
    expect(apiPost).toHaveBeenCalledWith(
      "/setup-api/coding-agent/team/message",
      { teamId: "team-k3x9q2ab", fromRunId: "run-ab12cd34", role: "worker", to: "lead", text: "The task names src/cart.ts and there is no src/." },
      { timeoutMs: TEAM_MESSAGE_CALL_TIMEOUT_MS },
    );
    if (!out.isError) expect(out.text).toMatch(/Posted on the team's board for the lead\. Nobody answers there/);
  });

  it("names the sibling for a sibling, and tells the sender not to wait for a reply", async () => {
    apiPost.mockResolvedValueOnce({ sent: true, to: "sibling", toRunId: "run-bbbbbbbb", delivered: false, left: 3 });
    const out = await teamTools().call("team_message", { to: "sibling", to_run_id: "run-bbbbbbbb", text: "Need your total() first" });
    expect(apiPost.mock.calls[0][1]).toMatchObject({ to: "sibling", toRunId: "run-bbbbbbbb" });
    expect(out.isError).toBe(false);
    if (!out.isError) {
      expect(out.text).toMatch(/Queued for run-bbbbbbbb/);
      expect(out.text).toMatch(/do not wait for a reply/);
      expect(out.text).toMatch(/3 team messages left/);
    }
  });

  it("refuses a sibling message with no run id before anything is sent", async () => {
    const out = await teamTools().call("team_message", { to: "sibling", text: "hi" });
    expect(out).toMatchObject({ isError: true, error: { code: "BAD_ARGUMENT" } });
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("does not forward a to_run_id for the lead or the assistant", async () => {
    await teamTools().call("team_message", { to: "owner_agent", to_run_id: "run-bbbbbbbb", text: "Stripe or PayPal?" });
    expect(apiPost.mock.calls[0][1]).not.toHaveProperty("toRunId");
  });
});

describe("what a refusal says", () => {
  it.each([
    [429, "RATE_LIMITED", { nextAllowedAt: Date.UTC(2026, 8, 22, 14, 32, 10) }, "CONFLICT", /Do not try again before 2026-09-22T14:32:10\.000Z/],
    [429, "RATE_LIMITED", { nextAllowedAt: null }, "CONFLICT", /no team messages left: put what you wanted to say in your final report/],
    [409, "SETTLED", {}, "CONFLICT", /do not message it again/],
    [404, "NOT_IN_TEAM", {}, "NOT_FOUND", /Only runs of your own team/],
    [400, "SELF", {}, "BAD_ARGUMENT", /Name another run/],
    [403, "FORBIDDEN", {}, "CONFLICT", /Do not retry/],
    [503, "NO_SESSION", {}, "ENDPOINT_DOWN", /Do not retry; send it to the lead/],
    [501, "UNSUPPORTED", {}, "NOT_SUPPORTED_HERE", /cannot be reached this way on this ClawBox. Do not retry; send it to the lead/],
    [502, "NOT_DELIVERED", {}, "ENDPOINT_DOWN", /Try once more at most/],
    [413, "TOO_LONG", {}, "TOO_LARGE", /at most 1500 characters/],
  ])("%s %s", async (status, code, extra, envelope, next) => {
    apiPost.mockRejectedValueOnce(new ApiError(status, refusalBody(code, `the route's reason for ${code}`, extra)));
    const out = await teamTools().call("team_message", { to: "lead", text: "hi" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe(envelope);
    expect(out.error.message).toBe(`${code}: the route's reason for ${code}`);
    expect(out.error.next).toMatch(next);
  });

  it("classifies anything that is not the route's own refusal the ordinary way", async () => {
    apiPost.mockRejectedValueOnce(new ApiError(401, "<html>login</html>"));
    const out = await teamTools().call("team_message", { to: "lead", text: "hi" });
    expect(out.isError).toBe(true);
    if (out.isError) expect(out.error.code).toBe("AUTH_FAILED");
  });
});
