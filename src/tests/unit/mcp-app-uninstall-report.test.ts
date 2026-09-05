import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-551 — what `app_uninstall` TELLS the agent about a removal.
 *
 * The route's own answers are covered in `src/tests/routes/apps/`; this file
 * covers the sentence the agent relays to the owner, which is the only part of
 * the outcome a person ever sees. Two of the four cases are refusals, and a
 * refusal that describes itself wrongly is the same defect as a `{ok:true}`
 * over a removal that did not happen:
 *
 *   - `skill_remove_failed` — `fs.rm` deletes as it WALKS, so part of the skill
 *     folder may already be gone. "Nothing was removed" is false there.
 *   - `config_unreadable` — answered before the first deletion, so nothing was
 *     touched and saying so is true.
 *   - `skillRemoved: false` — a skills root exists and held no skill of that
 *     name; the agent must not report a skill removal.
 *   - `skillRemoved: null` — no skill half to report on (the hermes SKU, or a
 *     web app), so the reply says nothing about skills at all.
 */

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

// The real `rules` plumbing, so a rule that stops matching is a failure here
// rather than a silently generic 503 the agent reads as "the service is down".
vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError, matchRule } = await import("../../../mcp/lib/errors");
  return {
    apiGet: (...a: unknown[]) => apiGet(...a),
    apiPost: async (route: string, body: unknown, opts?: { rules?: Parameters<typeof matchRule>[1] }) => {
      try {
        return await apiPost(route, body, opts);
      } catch (err) {
        if (err instanceof ApiError) throw matchRule(err, opts?.rules) ?? err;
        throw err;
      }
    },
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

import { ApiError } from "../../../mcp/lib/errors";
import type { McpContext } from "../../../mcp/lib/context";
import { registerDesktopTools } from "../../../mcp/tools/desktop";
import { captureRegistrar } from "../helpers/mcp-registrar";

const APP = "notes";

const ctx = (edition: "openclaw" | "hermes"): McpContext => ({
  edition,
  install: edition,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers: [],
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
});

function uninstall(edition: "openclaw" | "hermes" = "openclaw") {
  const h = captureRegistrar(edition);
  registerDesktopTools(h.reg, ctx(edition));
  return h.call("app_uninstall", { app_id: APP });
}

beforeEach(() => {
  apiGet.mockResolvedValue({ installed_apps: [APP] });
  apiPost.mockReset();
});

describe("app_uninstall — what the agent is told", () => {
  it("does not claim nothing was removed when the folder was PART-removed", async () => {
    apiPost.mockRejectedValue(
      new ApiError(
        503,
        JSON.stringify({
          ok: false,
          error: "The app's skill folder could not be fully removed, so the uninstall was stopped and part of the folder may already be gone.",
          code: "skill_remove_failed",
          retryable: true,
          appId: APP,
        }),
      ),
    );

    const out = await uninstall();

    expect(out.isError).toBe(true);
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.message).not.toMatch(/nothing was removed/i);
    expect(out.error.message).toMatch(/may already be gone/i);
    // Still the app-is-still-here fact, and still a retry rather than the
    // generic 503's detour through clawbox_health.
    expect(out.error.message).toMatch(/still on the desktop/i);
    expect(out.error.next).toMatch(/app_uninstall/);
  });

  it("says nothing was removed for the refusal where that is true", async () => {
    apiPost.mockRejectedValue(
      new ApiError(
        503,
        JSON.stringify({ ok: false, error: "…", code: "config_unreadable", retryable: true, appId: APP }),
      ),
    );

    const out = await uninstall();

    expect(out.isError).toBe(true);
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.message).toMatch(/nothing was removed/i);
  });

  it("reports a desktop-only removal without claiming a skill went with it", async () => {
    apiPost.mockResolvedValue({ ok: true, appId: APP, skillRemoved: false });

    const out = await uninstall();

    expect(out.isError).toBe(false);
    if (out.isError) throw new Error("unreachable");
    expect(out.text).toMatch(/There was no skill of that name on disk/);
  });

  it("says nothing about skills when there was no skill half at all", async () => {
    apiPost.mockResolvedValue({ ok: true, appId: APP, skillRemoved: null });

    const out = await uninstall("hermes");

    expect(out.isError).toBe(false);
    if (out.isError) throw new Error("unreachable");
    expect(out.text).toBe(`Removed "${APP}" from the desktop.`);
  });
});
