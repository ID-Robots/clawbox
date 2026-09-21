import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-453 crit-10 — "build me an app" wrote to a tree nothing ever builds.
 *
 * code_project_init used to hand the agent the literal string
 * "data/code-projects/<id>/". The project really lives under the WEB tier's
 * working directory (/home/clawbox/clawbox), but the agent edits files with its
 * HARNESS's own file tools, and on a Hermes device that process runs from
 * /home/clawbox. So the same relative string resolved to two different places:
 *
 *   read  data/code-projects/x/style.css   -> "File not found"
 *   write data/code-projects/x/index.html  -> verified:true, into
 *                                             /home/clawbox/data/... — a
 *                                             parallel tree the build ignores
 *
 * Three success messages, and the desktop icon opened the untouched scaffold.
 *
 * The property pinned below is the fix: the path the tool emits must be
 * ABSOLUTE, so it resolves to the real project directory from ANY working
 * directory — which is the only thing the two processes can agree on.
 */

const CLAWBOX_ROOT = "/home/clawbox/clawbox";
const REAL_PROJECT_DIR = `${CLAWBOX_ROOT}/data/code-projects/notes`;

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

// The mock keeps the ONE behaviour of the real api() these tests depend on:
// a non-2xx is run through the caller's ErrorRule list before it escapes, so a
// per-route rule is exercised rather than assumed.
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
import { registerDesktopTools } from "../../../mcp/tools/desktop";
import type { McpContext } from "../../../mcp/lib/context";

const ctx = (edition: "openclaw" | "hermes"): McpContext => ({
  edition,
  install: edition,
  appHarness: edition,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
});

/** Route replies for the two calls code_project_init makes, in order. */
function codeApiReplies(replies: Record<string, unknown>[]): void {
  let i = 0;
  apiPost.mockImplementation(async () => replies[Math.min(i++, replies.length - 1)]);
}

function harness(edition: "openclaw" | "hermes" = "hermes") {
  const h = captureRegistrar(edition);
  registerDesktopTools(h.reg, ctx(edition));
  return h;
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

describe("code_project_init — the path handed to the agent", () => {
  const FILES = [
    { name: "index.html", type: "file" },
    { name: "style.css", type: "file" },
    { name: "app.js", type: "file" },
  ];

  it("reports the absolute directory the route says the project is in", async () => {
    codeApiReplies([
      { success: true, path: REAL_PROJECT_DIR },
      { files: FILES, path: REAL_PROJECT_DIR },
    ]);
    const out = await harness().call("code_project_init", {
      project_id: "notes",
      name: "Notes",
      template: "app",
    });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain(`${REAL_PROJECT_DIR}/`);
    expect(out.text).toContain(`${REAL_PROJECT_DIR}/index.html`);
  });

  /**
   * The regression itself. Any path the agent is given must survive being
   * resolved against a working directory that is NOT the web tier's — which is
   * precisely what the Hermes agent process does.
   */
  it("emits paths that resolve to the real project from any working directory", async () => {
    codeApiReplies([
      { success: true, path: REAL_PROJECT_DIR },
      { files: FILES, path: REAL_PROJECT_DIR },
    ]);
    const out = await harness().call("code_project_init", {
      project_id: "notes",
      name: "Notes",
      template: "app",
    });
    if (out.isError) throw new Error("init failed");

    const emitted = out.text.match(/\S*index\.html/)?.[0];
    expect(emitted).toBeTruthy();
    for (const cwd of ["/home/clawbox", "/home/clawbox/clawbox", "/", "/tmp"]) {
      expect(path.resolve(cwd, emitted as string)).toBe(`${REAL_PROJECT_DIR}/index.html`);
    }
  });

  it("never emits the bare relative form that resolved to the wrong tree", async () => {
    codeApiReplies([
      { success: true, path: REAL_PROJECT_DIR },
      { files: FILES, path: REAL_PROJECT_DIR },
    ]);
    const out = await harness().call("code_project_init", {
      project_id: "notes",
      name: "Notes",
      template: "app",
    });
    if (out.isError) throw new Error("init failed");
    expect(out.text).not.toMatch(/(^|[\s"'`])data\/code-projects\//);
  });

  it("falls back to CLAWBOX_ROOT on a device whose route reports no path", async () => {
    codeApiReplies([{ success: true }, { files: FILES }]);
    const out = await harness().call("code_project_init", {
      project_id: "notes",
      name: "Notes",
      template: "app",
    });
    if (out.isError) throw new Error("init failed");
    expect(out.text).toContain(`${REAL_PROJECT_DIR}/index.html`);
  });

  it("ignores a relative path from the route rather than passing it on", async () => {
    codeApiReplies([
      { success: true, path: "data/code-projects/notes" },
      { files: FILES, path: "data/code-projects/notes" },
    ]);
    const out = await harness().call("code_project_init", {
      project_id: "notes",
      name: "Notes",
      template: "app",
    });
    if (out.isError) throw new Error("init failed");
    expect(out.text).toContain(`${REAL_PROJECT_DIR}/index.html`);
  });

  it("tells the agent to use the absolute paths verbatim", () => {
    const description = harness().get("code_project_init").description;
    expect(description).toMatch(/absolute/i);
  });
});

describe("code_project_list — the same path contract", () => {
  it("reports an absolute directory per project", async () => {
    apiPost.mockResolvedValue({
      projects: [
        { projectId: "notes", name: "Notes", updated: "2026-08-22", path: REAL_PROJECT_DIR },
        { projectId: "timer", name: "Timer", updated: "2026-08-22" },
      ],
    });
    const out = await harness().call("code_project_list", {});
    if (out.isError) throw new Error("list failed");
    const rows = JSON.parse(out.text) as { id: string; path: string }[];
    expect(rows.map((r) => r.path)).toEqual([
      REAL_PROJECT_DIR,
      `${CLAWBOX_ROOT}/data/code-projects/timer`,
    ]);
    for (const row of rows) expect(path.isAbsolute(row.path)).toBe(true);
  });
});

describe("code project 404s stay about the id, not the edition", () => {
  it("points a missing project at code_project_list instead of device_status", async () => {
    const { ApiError } = await import("../../../mcp/lib/errors");
    apiPost.mockRejectedValue(new ApiError(404, JSON.stringify({ error: "Project not found" })));
    // The rule lives on the shared codeApi helper, so every code tool gets it.
    const out = await harness().call("code_project_build", {
      project_id: "gone",
      open_after_build: false,
    });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.message).toMatch(/code project/i);
    expect(out.error.next).toMatch(/code_project_list/);
    expect(out.error.next).not.toMatch(/device_status/);
  });
});
