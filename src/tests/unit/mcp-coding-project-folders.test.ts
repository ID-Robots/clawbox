/**
 * The multi-folder project tools (TASK-2757, mcp/tools/coding-agent.ts):
 * coding_project_create, coding_project_folder_add,
 * coding_project_folder_remove and coding_project_folders.
 *
 * What the agent sees: each posts the one body the route takes, the reply
 * names the folders and how to run the project (`project_id`), and the
 * route's typed refusals come back as a next step rather than a retry.
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
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS, paramDescriptionViolations } from "../../../mcp/lib/register";

const TOOLS = ["coding_project_create", "coding_project_folder_add", "coding_project_folder_remove", "coding_project_folders"];
const ROUTE = "/setup-api/coding-agent/project-folders";

function harness(edition: "openclaw" | "hermes" = "openclaw") {
  const h = captureRegistrar(edition);
  registerCodingAgentTools(h.reg, { codingAgent: true });
  return h;
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("registration", () => {
  it("is on both editions behind the coding agent's switch, and only the list is read-only", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const h = harness(edition);
      for (const name of TOOLS) {
        const tool = h.get(name);
        expect(tool.opts.readOnly).toBe(name === "coding_project_folders");
        expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
        expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
        expect(paramDescriptionViolations({ name, shape: tool.shape } as never)).toEqual([]);
      }
    }
    const off = captureRegistrar("openclaw");
    registerCodingAgentTools(off.reg, { codingAgent: false });
    for (const name of TOOLS) expect(off.has(name)).toBe(false);
  });
});

describe("what each one asks the box", () => {
  it("creates a project from its folders and says how to run it", async () => {
    apiPost.mockResolvedValue({ project: "skyhub", folders: [{ folder: "gateway" }, { folder: "dashboard", base: "develop" }] });
    const out = await harness().call("coding_project_create", { project: "skyhub", folders: ["gateway", "dashboard"] });
    expect(out.isError).toBe(false);
    expect(apiPost).toHaveBeenCalledWith(ROUTE, { project: "skyhub", action: "create", folders: ["gateway", "dashboard"] }, expect.anything());
    expect((out as { text: string }).text).toContain("gateway, dashboard (from develop)");
    expect((out as { text: string }).text).toContain('coding_agent_run project_id "skyhub"');
  });

  it("adds a folder with its base branch, and removes one", async () => {
    apiPost.mockResolvedValue({ project: "gateway", folders: [{ folder: "gateway" }, { folder: "dashboard", base: "main" }] });
    await harness().call("coding_project_folder_add", { project: "gateway", folder: "dashboard", base_branch: "main" });
    expect(apiPost).toHaveBeenLastCalledWith(ROUTE, { project: "gateway", action: "add", folder: "dashboard", base: "main" }, expect.anything());
    apiPost.mockResolvedValue({ project: "gateway", folders: [] });
    const out = await harness().call("coding_project_folder_remove", { project: "gateway", folder: "dashboard" });
    expect(apiPost).toHaveBeenLastCalledWith(ROUTE, { project: "gateway", action: "remove", folder: "dashboard" }, expect.anything());
    expect((out as { text: string }).text).toContain("single-folder project");
  });

  it("lists every multi-folder project, or one", async () => {
    apiGet.mockResolvedValue({ projects: [{ project: "skyhub", folders: [{ folder: "gateway" }, { folder: "dashboard" }] }] });
    const all = await harness().call("coding_project_folders", {});
    expect(apiGet).toHaveBeenLastCalledWith(ROUTE, expect.not.objectContaining({ query: expect.anything() }));
    expect((all as { text: string }).text).toContain("skyhub: gateway, dashboard");
    apiGet.mockResolvedValue({ project: "skyhub", folders: [{ folder: "gateway" }] });
    await harness().call("coding_project_folders", { project: "skyhub" });
    expect(apiGet).toHaveBeenLastCalledWith(ROUTE, expect.objectContaining({ query: { project: "skyhub" } }));
  });

  it("turns a folder that is no repository into advice, not a retry", async () => {
    apiPost.mockRejectedValue(new ApiError(400, JSON.stringify({ error: "notes is not a git repository directly inside the project folder (/srv/p).", kind: "not_a_repository" })));
    const out = await harness().call("coding_project_folder_add", { project: "gateway", folder: "notes" });
    expect(out.isError).toBe(true);
    const err = (out as { error: { code: string; message: string; next: string } }).error;
    expect(err.code).toBe("BAD_ARGUMENT");
    expect(err.message).toContain("notes is not a git repository");
    expect(err.next).toContain("coding_project_status");
  });
});
