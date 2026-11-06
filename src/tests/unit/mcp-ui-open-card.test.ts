/**
 * `ui_open_card` and `ui_open_app`'s coding targets (mcp/tools/desktop.ts, the
 * 2026-10-30 redesign's step 3): the assistant opens the chat's Create card
 * itself, and opens the Coding Agent ON a run, a team or a project in one
 * call. Both are ring actions page.tsx reads; the device call is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiPost, apiTry } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiTry: vi.fn() }));
vi.mock("../../../mcp/lib/api", () => ({
  apiGet,
  apiPost,
  apiTry,
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/srv/clawbox",
}));

import type { McpContext } from "../../../mcp/lib/context";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerDesktopTools } from "../../../mcp/tools/desktop";

const ctx: McpContext = {
  edition: "openclaw",
  install: "openclaw",
  appHarness: "openclaw",
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: true,
  canGenerateImages: false,
};

function harness() {
  const h = captureRegistrar("openclaw");
  registerDesktopTools(h.reg, ctx);
  return h;
}

/** The action the tool handed the desktop: what /setup-api/kv was asked to fold into the ring. */
function pushed(): Record<string, unknown>[] {
  return apiPost.mock.calls
    .filter(([path]) => path === "/setup-api/kv")
    .map(([, body]) => JSON.parse((body as { value: string }).value) as Record<string, unknown>)
    .map(({ ts: _ts, ...rest }) => rest);
}

beforeEach(() => {
  apiPost.mockReset().mockResolvedValue({});
  apiGet.mockReset().mockResolvedValue({ installed_apps: [] });
  apiTry.mockReset().mockResolvedValue(null);
});

describe("ui_open_card", () => {
  it("is registered on both editions in the core profile", () => {
    const tool = harness().get("ui_open_card");
    expect(tool.opts).toMatchObject({ editions: ["openclaw", "hermes"], profile: "core", readOnly: false });
    expect(Object.keys(tool.shape).sort()).toEqual(["card", "project_id", "team"]);
  });

  it("pushes an open_card action for the Create card, bare or on a project with the team switch", async () => {
    const out = await harness().call("ui_open_card", { card: "new_app", team: false });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/Opened the "A new app for your desktop" card/);
    expect(out.text).toMatch(/fill it in and stop/);
    expect(pushed()).toEqual([{ type: "open_card", card: "new_app" }]);

    apiPost.mockClear();
    const onProject = await harness().call("ui_open_card", { card: "new_app", project_id: "/srv/projects/invoice", team: true });
    expect(onProject.isError).toBe(false);
    expect(pushed()).toEqual([{ type: "open_card", card: "new_app", project: "/srv/projects/invoice", team: true }]);
  });

  it("refuses a card it does not have and a project that is not an absolute folder", async () => {
    const other = await harness().call("ui_open_card", { card: "settings", team: false });
    expect(other.isError).toBe(true);
    if (other.isError) expect(other.error.code).toBe("BAD_ARGUMENT");
    const relative = await harness().call("ui_open_card", { card: "new_app", project_id: "invoice", team: false });
    expect(relative.isError).toBe(true);
    if (relative.isError) expect(relative.error.message).toMatch(/absolute folder path/);
    expect(pushed()).toEqual([]);
  });
});

describe("ui_open_app with a coding target", () => {
  it("carries the run, the team or the project as the open_app action's target", async () => {
    const h = harness();
    expect(Object.keys(h.get("ui_open_app").shape).sort()).toEqual(["app_id", "project_id", "run_id", "team_id"]);

    const run = await h.call("ui_open_app", { app_id: "coding", run_id: "run-k3x9q2ab" });
    expect(run.isError).toBe(false);
    if (!run.isError) expect(run.text).toMatch(/Opened the Coding Agent on run run-k3x9q2ab/);
    expect(pushed()).toEqual([{ type: "open_app", appId: "coding", target: { runId: "run-k3x9q2ab" } }]);

    apiPost.mockClear();
    await h.call("ui_open_app", { app_id: "coding", team_id: "team-k3x9q2ab" });
    expect(pushed()).toEqual([{ type: "open_app", appId: "coding", target: { teamId: "team-k3x9q2ab" } }]);

    apiPost.mockClear();
    await h.call("ui_open_app", { app_id: "coding", project_id: "invoice" });
    expect(pushed()).toEqual([{ type: "open_app", appId: "coding", target: { projectId: "invoice" } }]);

    // Without a target the action is what it always was.
    apiPost.mockClear();
    await h.call("ui_open_app", { app_id: "coding" });
    expect(pushed()).toEqual([{ type: "open_app", appId: "coding" }]);
  });

  it("refuses a target on another app, and an id that is not the box's shape", async () => {
    const h = harness();
    const files = await h.call("ui_open_app", { app_id: "files", run_id: "run-k3x9q2ab" });
    expect(files.isError).toBe(true);
    if (files.isError) expect(files.error.message).toMatch(/only apply to the "coding" app/);
    const badRun = await h.call("ui_open_app", { app_id: "coding", run_id: "not-a-run" });
    expect(badRun.isError).toBe(true);
    const badTeam = await h.call("ui_open_app", { app_id: "coding", team_id: "team-TOO-LONG-0000" });
    expect(badTeam.isError).toBe(true);
    const badProject = await h.call("ui_open_app", { app_id: "coding", project_id: "../etc" });
    expect(badProject.isError).toBe(true);
    expect(pushed()).toEqual([]);
  });
});
