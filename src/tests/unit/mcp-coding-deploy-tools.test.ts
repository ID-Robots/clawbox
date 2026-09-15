/**
 * The coding_deploy_* MCP tools (mcp/tools/coding-agent.ts).
 *
 * What the agent actually sees:
 *
 *  1. TWO TOOLS, NOT ONE WITH A `target`. The target comes from WHICH tool was
 *     called, so there is no value a model can send that turns a preview into a
 *     production deployment.
 *  2. NEITHER CAN NAME A VERCEL PROJECT. No parameter anywhere takes a Vercel
 *     project, a team or a token — the device resolves the owner's link — so a
 *     prompt-injected agent cannot deploy the owner's code to an account it
 *     chose.
 *  3. THE REFUSALS ARE ACTIONABLE AND DIFFERENT FROM EACH OTHER. "The owner has
 *     not allowed production for this project" must not read as "retry", and
 *     the rate limit must not read as "try another way".
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

import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerCodingAgentTools } from "../../../mcp/tools/coding-agent";
import { ApiError } from "../../../mcp/lib/errors";

const DEPLOYED = {
  linked: true,
  deploy: {
    target: "preview", phase: "building", url: "https://shop-abc.vercel.app",
    inspectorUrl: "https://vercel.com/acme/shop/dpl_1", deploymentId: "dpl_1",
    source: "files", gitRef: null, fileCount: 7,
  },
  production: { left: 3, max: 3 },
  usedGit: true,
  skipped: [],
};

/** The text a successful call answered. */
function said(out: Awaited<ReturnType<ReturnType<typeof harness>["call"]>>): string {
  return out.isError ? JSON.stringify(out.error) : out.text;
}

function harness(edition: "openclaw" | "hermes" = "openclaw", codingAgent = true, codingVercel = true) {
  const h = captureRegistrar(edition);
  registerCodingAgentTools(h.reg, { codingAgent, codingVercel });
  return h;
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue(DEPLOYED);
});

describe("registration", () => {
  it("is offered on both editions, under the coding agent's own switch", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      expect(harness(edition).names()).toContain("coding_deploy_preview");
      expect(harness(edition).names()).toContain("coding_deploy_production");
    }
    // Off, the whole family is absent — a tool that could only answer 409
    // would trip Hermes' per-server circuit breaker.
    expect(harness("openclaw", false).names()).toEqual([]);
  });

  it("is absent when the owner has the box-wide Vercel integration switched off", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const names = harness(edition, true, false).names();
      // The two deploy tools are gone…
      expect(names).not.toContain("coding_deploy_preview");
      expect(names).not.toContain("coding_deploy_production");
      // …and nothing else in the family went with them: the owner switched off
      // Vercel, not the coding agent.
      expect(names).toContain("coding_agent_run");
      expect(names).toContain("coding_agent_status");
    }
  });

  it("says so on delivery_pipeline rather than promising a deploy that will be skipped", () => {
    const described = (codingVercel: boolean) => {
      const shape = harness("openclaw", true, codingVercel).get("coding_agent_run").shape as
        Record<string, { description?: string }>;
      return shape.delivery_pipeline.description ?? "";
    };
    expect(described(true)).not.toMatch(/switched off/i);
    expect(described(false)).toMatch(/switched off on this ClawBox/i);
    expect(described(false)).toMatch(/skipped/i);
    // And on such a box the parameter never NAMES the integration: it is a
    // beta flag the owner has not turned on, and a description that named it
    // would have the assistant offering a feature the box has not shown them.
    expect(described(false)).not.toMatch(/vercel/i);
    expect(described(true)).toMatch(/vercel/i);
  });

  it("offers no parameter that could name a Vercel project, team or token", () => {
    for (const name of ["coding_deploy_preview", "coding_deploy_production"]) {
      expect(Object.keys(harness().get(name).shape).sort(), name).toEqual(["directory", "project_id", "run_id"]);
    }
  });

  it("offers no tool for the owner's auto-production switch", () => {
    expect(harness().names().filter((n) => /auto|allow|switch/i.test(n))).toEqual([]);
  });
});

describe("deploying", () => {
  it("sends the target of the TOOL, never one the model chose", async () => {
    await harness().call("coding_deploy_preview", { project_id: "shop" });
    expect(apiPost.mock.calls[0][1]).toEqual({ target: "preview", projectId: "shop" });
    apiPost.mockClear();
    await harness().call("coding_deploy_production", { project_id: "shop" });
    expect(apiPost.mock.calls[0][1]).toEqual({ target: "production", projectId: "shop" });
  });

  it("carries a run id through, so the deployment lands on that run's record", async () => {
    await harness().call("coding_deploy_preview", { run_id: "run-k3x9q2ab" });
    expect(apiPost.mock.calls[0][1]).toEqual({ target: "preview", runId: "run-k3x9q2ab" });
  });

  it("names the address and tells the caller to stop rather than poll", async () => {
    const out = await harness().call("coding_deploy_preview", { project_id: "shop" });
    expect(out.isError).toBe(false);
    expect(said(out)).toContain("https://shop-abc.vercel.app");
    expect(said(out)).toMatch(/do not poll/i);
  });

  it("says when this box could not ask git what to leave out", async () => {
    apiPost.mockResolvedValue({ ...DEPLOYED, usedGit: false });
    expect(said(await harness().call("coding_deploy_preview", { project_id: "shop" }))).toMatch(/could not ask git/i);
  });

  it("names the branch when Vercel built from the connected repository", async () => {
    apiPost.mockResolvedValue({ ...DEPLOYED, deploy: { ...DEPLOYED.deploy, source: "git", gitRef: "main" } });
    expect(said(await harness().call("coding_deploy_preview", { project_id: "shop" }))).toContain("main");
  });

  it("refuses to call the device at all when nothing was named", async () => {
    const out = await harness().call("coding_deploy_preview", {});
    expect(out.isError).toBe(true);
    expect(out.isError && out.error.message).toMatch(/Nothing was named/);
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("the refusals", () => {
  const refusal = (status: number, code: string) =>
    apiPost.mockRejectedValue(new ApiError(status, JSON.stringify({ error: "no", code, kind: code })));

  it("sends the agent to the OWNER when production is not allowed, and offers the preview instead", async () => {
    refusal(403, "auto_production_off");
    const out = await harness().call("coding_deploy_production", { project_id: "shop" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).toMatch(/does not let its assistant deploy/i);
    expect(out.error.next).toMatch(/coding_deploy_preview/);
    expect(out.error.next).toMatch(/do not retry/i);
  });

  it("says a rate limit is a thing to tell the user, not a thing to retry", async () => {
    refusal(429, "rate_limited");
    const out = await harness().call("coding_deploy_production", { project_id: "shop" });
    expect(out.isError && out.error.next).toMatch(/do not retry/i);
  });

  it("sends the agent to the owner for a project with no Vercel project attached", async () => {
    refusal(400, "not_linked");
    const out = await harness().call("coding_deploy_preview", { project_id: "shop" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).toMatch(/No Vercel project is attached/i);
    expect(out.error.next).toMatch(/attach one/i);
  });
});
