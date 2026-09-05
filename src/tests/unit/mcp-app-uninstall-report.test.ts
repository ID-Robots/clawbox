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
  // The APP harness (#627). `app_uninstall` asks `installedAppIds(null)` for
  // the UNFILTERED list — an app this harness cannot open is still the owner's
  // to remove — so this value does not steer these cases; it is the edition
  // here so the context is the shape a real box hands the registrar.
  appHarness: edition,
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

  it("says the skill half was NOT LOOKED AT when the config could not be read", async () => {
    // A web app removed while openclaw.json is unreadable: the route does not
    // refuse (a `dual` box's idle harness must not strand the agent's own
    // pages) and cannot look at the skill half either, so its `null` here is
    // "could not check", not "there was none" — an id can be both. Reported as
    // a plain removal it is the same false success this whole PR is about, one
    // condition narrower.
    apiPost.mockResolvedValue({ ok: true, appId: APP, skillRemoved: null, skillHalfChecked: false });

    const out = await uninstall();

    expect(out.isError).toBe(false);
    if (out.isError) throw new Error("unreachable");
    expect(out.text).toMatch(/could not be read/i);
    expect(out.text).toMatch(/still/i);
    expect(out.text).not.toBe(`Removed "${APP}" from the desktop.`);
    // ...and it does NOT send the agent back into app_uninstall: the desktop
    // entry has already gone, so the tool's own pre-check (`installedAppIds`)
    // would answer "there is no installed app with that id" — a contradiction
    // on top of the fact that actually matters.
    expect(out.text).toMatch(/Do not call app_uninstall again/i);
  });

  it("does not send the agent to a health check over a 500 that answered precisely", async () => {
    // The outer catch reports whether the skill folder had already gone. Both
    // `rules` entries are 503, so a 500 fell through to the generic
    // ENDPOINT_DOWN — "call clawbox_health, then retry once" — over a route
    // that had just said the app is only PARTLY gone.
    apiPost.mockRejectedValue(
      new ApiError(
        500,
        JSON.stringify({
          ok: false,
          error: "The uninstall failed after the app's skill folder had already been removed, so the app is only partly gone. Try again.",
          code: "uninstall_failed",
          retryable: true,
          skillRemoved: true,
        }),
      ),
    );

    const out = await uninstall();

    expect(out.isError).toBe(true);
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.message).not.toMatch(/did not complete this request/i);
    expect(out.error.message).toMatch(/partly/i);
    expect(out.error.next).toMatch(/app_uninstall/);
  });

  it("does not invent a half-removed skill folder in the 500 where none was touched", async () => {
    // The same 500, with the route reporting that no skill folder went. On the
    // hermes SKU no skills path is ever resolved, so "its skill folder may
    // already be gone" would be a false report in the other direction — the
    // reason the two 503s are two rules, applied to the 500 as well.
    apiPost.mockRejectedValue(
      new ApiError(
        500,
        JSON.stringify({
          ok: false,
          error: "The uninstall failed. Try again in a moment.",
          code: "uninstall_failed",
          retryable: true,
          skillRemoved: null,
        }),
      ),
    );

    const out = await uninstall("hermes");

    expect(out.isError).toBe(true);
    if (!out.isError) throw new Error("unreachable");
    expect(out.error.message).not.toMatch(/did not complete this request/i);
    expect(out.error.message).not.toMatch(/skill/i);
    expect(out.error.message).toMatch(/nothing is known to have been removed/i);
  });
});
