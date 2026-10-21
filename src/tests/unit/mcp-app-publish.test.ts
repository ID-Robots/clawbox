/**
 * `app_publish` — the Coding Agent's "Publish to ClawBox Store" for chat
 * (mcp/tools/coding-agent.ts). Behind the coding agent's switch on both
 * editions; every typed refusal of POST /setup-api/apps/publish reaches the
 * agent with the route's own sentence and the next step that can change it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock("../../../mcp/lib/api", () => ({
  apiGet: vi.fn(),
  apiTry: vi.fn(),
  apiPost: (...a: unknown[]) => apiPost(...a),
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

import { ApiError } from "../../../mcp/lib/errors";
import { BANNED_DESCRIPTION_RE, MAX_DESCRIPTION_CHARS } from "../../../mcp/lib/register";
import { PARAM_NAME_RE, TOOL_NAME_RE } from "../../../mcp/lib/schema";
import { registerAppPublishTools } from "../../../mcp/tools/coding-agent";
import { captureRegistrar } from "../helpers/mcp-registrar";

function harness(edition: "openclaw" | "hermes" = "openclaw", codingAgent = true) {
  const h = captureRegistrar(edition);
  registerAppPublishTools(h.reg, { codingAgent });
  return h;
}

const refused = (status: number, body: unknown) => new ApiError(status, JSON.stringify(body));

beforeEach(() => {
  apiPost.mockReset();
});

describe("app_publish registration", () => {
  it("is offered on both editions only while the coding agent is on", () => {
    expect(harness("openclaw", false).names()).toEqual([]);
    expect(harness("openclaw").names()).toEqual(["app_publish"]);
    expect(harness("hermes").names()).toEqual(["app_publish"]);
  });

  it("keeps its name, parameters and description inside the contract", () => {
    const tool = harness().get("app_publish");
    expect("app_publish").toMatch(TOOL_NAME_RE);
    for (const param of Object.keys(tool.shape)) expect(param).toMatch(PARAM_NAME_RE);
    expect(Object.keys(tool.shape).sort()).toEqual(["description", "project_id", "version"]);
    expect(tool.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(tool.description).not.toMatch(BANNED_DESCRIPTION_RE);
    expect(tool.opts.editions).toEqual(["openclaw", "hermes"]);
    expect(tool.opts.readOnly).toBe(false);
  });
});

describe("app_publish", () => {
  it("posts the project to the publish route and says where it is", async () => {
    apiPost.mockResolvedValue({ ok: true, app: { name: "Tinder Clone", version: "1.0.0" }, created: true, storeUrl: "https://portal.example/portal/apps" });
    const out = await harness().call("app_publish", { project_id: "tinder-clone", version: "1.0.0", description: "Swipe" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toBe("Published Tinder Clone 1.0.0 to the ClawBox Store. The owner can see it at https://portal.example/portal/apps.");
    expect(apiPost).toHaveBeenCalledWith("/setup-api/apps/publish", { projectId: "tinder-clone", version: "1.0.0", description: "Swipe" }, expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it("says a new version is a new version", async () => {
    apiPost.mockResolvedValue({ ok: true, app: { name: "Tinder Clone", version: "1.0.1" }, created: false });
    const out = await harness().call("app_publish", { project_id: "tinder-clone", version: "1.0.1" });
    expect(!out.isError && out.text).toBe("Published a new version of Tinder Clone 1.0.1 to the ClawBox Store.");
    expect(apiPost.mock.calls[0][1]).toEqual({ projectId: "tinder-clone", version: "1.0.1" });
  });

  it("relays coming_soon as not open here yet, with the plan's page, and no retry", async () => {
    apiPost.mockRejectedValue(refused(403, { ok: false, code: "coming_soon", message: "Publishing is coming soon with the Developer plan.", upgradeUrl: "https://portal.example/portal/apps", retryable: false }));
    const out = await harness().call("app_publish", { project_id: "tinder-clone", version: "1.0.0" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_SUPPORTED_HERE");
    expect(out.error.message).toBe("Publishing is coming soon with the Developer plan. The Developer plan: https://portal.example/portal/apps");
    expect(out.error.next).toMatch(/Do not retry/);
  });

  it.each([
    [409, "slug_taken", "CONFLICT", /another slug/],
    [413, "package_too_large", "TOO_LARGE", /\.gitignore/],
    [409, "not_linked", "AUTH_FAILED", /sign in to ClawBox AI/i],
    [422, "no_manifest", "BAD_ARGUMENT", /clawbox\.json/],
    [503, "store_unavailable", "ENDPOINT_DOWN", /once more/],
  ])("maps %i %s to %s", async (status, code, toolCode, next) => {
    apiPost.mockRejectedValue(refused(status, { ok: false, code, message: `The route's sentence for ${code}.` }));
    const out = await harness().call("app_publish", { project_id: "tinder-clone", version: "1.0.0" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe(toolCode);
    expect(out.error.message).toBe(`The route's sentence for ${code}.`);
    expect(out.error.next).toMatch(next);
  });

  it("leaves an answer that is not one of the route's codes to the generic mapping", async () => {
    apiPost.mockRejectedValue(refused(403, { error: "Only the box owner can do this.", code: "owner_only" }));
    const out = await harness().call("app_publish", { project_id: "tinder-clone", version: "1.0.0" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("AUTH_FAILED");
  });
});
