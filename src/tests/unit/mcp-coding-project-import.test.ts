/**
 * `coding_project_import` (mcp/tools/coding-agent.ts): the Coding Agent app's
 * Import panel as a tool, since the app carries no inputs (2026-10-30).
 *
 * What the agent sees: exactly one source is demanded; a repository goes to
 * the import route as `{ source: "github", repo }` and a folder as
 * `{ source: "folder", path }`; the reply names the new project's id the way
 * coding_agent_run wants it; and the route's typed refusals come back as a
 * next step for the user rather than a retry.
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
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS } from "../../../mcp/lib/register";

function harness(edition: "openclaw" | "hermes" = "openclaw") {
  const h = captureRegistrar(edition);
  registerCodingAgentTools(h.reg, { codingAgent: true });
  return h;
}

const IMPORTED = {
  project: { folder: "old-site", directory: "/srv/projects/old-site", name: "old-site", kind: "folder" },
  directory: "/srv/projects/old-site",
  folder: "old-site",
  initialized: false,
  skipped: [],
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("registration", () => {
  it("is on both editions behind the coding agent's switch, writes, and keeps the description contract", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      const tool = harness(edition).get("coding_project_import");
      expect(tool.opts.readOnly).toBe(false);
      expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
      expect(Object.keys(tool.shape).sort()).toEqual(["directory", "github_repo"]);
    }
    const off = captureRegistrar("openclaw");
    registerCodingAgentTools(off.reg, { codingAgent: false });
    expect(off.has("coding_project_import")).toBe(false);
  });
});

describe("the two sources", () => {
  it("clones a repository and answers the project's id the way coding_agent_run wants it", async () => {
    apiPost.mockResolvedValue(IMPORTED);
    const out = await harness().call("coding_project_import", { github_repo: "yalexx/old-site" });
    expect(out.isError).toBe(false);
    expect(apiPost).toHaveBeenCalledTimes(1);
    const [path, body, opts] = apiPost.mock.calls[0] as [string, unknown, { timeoutMs: number }];
    expect(path).toBe("/setup-api/coding-agent/projects/import");
    expect(body).toEqual({ source: "github", repo: "yalexx/old-site" });
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(120_000);
    const text = (out as { text: string }).text;
    expect(text).toContain("Cloned yalexx/old-site");
    expect(text).toMatch(/project_id: old-site$/);
  });

  it("copies a folder and says what was left behind and that git history was added", async () => {
    apiPost.mockResolvedValue({ ...IMPORTED, initialized: true, skipped: ["node_modules"] });
    const out = await harness().call("coding_project_import", { directory: "/srv/home/me/old-site" });
    expect(out.isError).toBe(false);
    expect(apiPost.mock.calls[0][1]).toEqual({ source: "folder", path: "/srv/home/me/old-site" });
    const text = (out as { text: string }).text;
    expect(text).toContain("Copied /srv/home/me/old-site");
    expect(text).toContain("Left behind: node_modules.");
    expect(text).toContain("no git history");
    expect(text).toContain('project_id "old-site"');
  });

  it("demands exactly one source — neither, or both, is a BAD_ARGUMENT and no request", async () => {
    for (const args of [{}, { github_repo: "a/b", directory: "/srv/x" }, { github_repo: "  " }]) {
      const out = await harness().call("coding_project_import", args);
      expect(out.isError).toBe(true);
      expect((out as { error: { code: string } }).error.code).toBe("BAD_ARGUMENT");
    }
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe("the route's refusals", () => {
  const refusal = (status: number, kind: string) => new ApiError(status, JSON.stringify({ error: "the box's own sentence", kind }));

  it("turns a taken name into CONFLICT with a next step that does not retry", async () => {
    apiPost.mockRejectedValue(refusal(409, "exists"));
    const out = await harness().call("coding_project_import", { github_repo: "yalexx/old-site" });
    expect(out.isError).toBe(true);
    const err = (out as { error: { code: string; message: string; next: string } }).error;
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("already");
    expect(err.next).toContain("Do not retry");
  });

  it("sends the user to Settings when no GitHub account is connected, and names the folder path as the way round", async () => {
    apiPost.mockRejectedValue(refusal(409, "not_connected"));
    const err = (await harness().call("coding_project_import", { github_repo: "yalexx/old-site" }) as { error: { code: string; next: string } }).error;
    expect(err.code).toBe("CONFLICT");
    expect(err.next).toContain("connect GitHub");
    expect(err.next).toContain("directory");
  });

  it("reports a refused source as BLOCKED_PATH without a retry", async () => {
    apiPost.mockRejectedValue(refusal(403, "refused"));
    const err = (await harness().call("coding_project_import", { directory: "/srv/home/me/.ssh" }) as { error: { code: string; next: string } }).error;
    expect(err.code).toBe("BLOCKED_PATH");
    expect(err.next).toContain("Do not retry");
  });

  it("maps size and disk refusals to TOO_LARGE", async () => {
    apiPost.mockRejectedValue(refusal(413, "too_big"));
    expect((await harness().call("coding_project_import", { directory: "/srv/home/me/big" }) as { error: { code: string } }).error.code).toBe("TOO_LARGE");
    apiPost.mockRejectedValue(refusal(507, "no_space"));
    expect((await harness().call("coding_project_import", { directory: "/srv/home/me/big" }) as { error: { code: string } }).error.code).toBe("TOO_LARGE");
  });
});
