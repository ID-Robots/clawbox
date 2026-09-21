import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MCP-02a — the residual left by #513, and its sibling on the other guard.
 *
 * #513 taught skill_uninstall to decode the uninstall route's two LABELLED
 * refusals (404 not_installed, 409 builtin_skill) and deliberately let an
 * UNLABELLED 404 fall through to the generic mapping, on the grounds that
 * "we cannot tell which failure it was" is the honest answer.
 *
 * The unlabelled 404 from these routes was not unknowable. Every
 * /setup-api/hermes/skills/* route opens with hermesSkillsGuard(), which
 * answered `{"error":"Not found"}` when the active harness is not Hermes — a
 * JSON body with a non-empty `error` string, which is exactly what
 * hasJsonErrorBody() reads as a RESOURCE-level 404. So the agent was told
 * "check the id you passed, list what actually exists first, then call this
 * tool again with one of those ids", when the real condition is an EDITION
 * mismatch: skill_list goes through the same guard and 404s too, so the
 * advised recovery cannot work. errors.ts's own comment at that branch names
 * this confusion, in the other direction, as the thing it must never do.
 *
 * openclawAppsGuard() is the same guard for the app store and had the same
 * defect — mcp/tools/desktop.ts's header comment already recorded that a
 * chronically-404ing tool trips the agent's circuit breaker.
 *
 * Both sets of tools are registered off an edition probe taken ONCE when the
 * MCP child spawned, so the window is a device whose harness changed since.
 */

const { apiGet, apiPost, activeHarness } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  activeHarness: vi.fn(async () => "openclaw" as string),
}));

// Reproduces what api() does around a call: a matched ErrorRule becomes a
// ToolError before the tool handler ever sees the ApiError.
vi.mock("../../../mcp/lib/api", async () => {
  const { ApiError, matchRule } = await import("../../../mcp/lib/errors");
  const withRules =
    (fn: (...a: unknown[]) => unknown) =>
    async (route: string, ...rest: unknown[]) => {
      try {
        return await fn(route, ...rest);
      } catch (err) {
        const opts = (rest[rest.length - 1] ?? {}) as { rules?: Parameters<typeof matchRule>[1] };
        if (err instanceof ApiError) throw matchRule(err, opts?.rules) ?? err;
        throw err;
      }
    };
  return {
    apiGet: withRules(apiGet),
    apiPost: withRules(apiPost),
    apiTry: vi.fn(async () => null),
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

vi.mock("@/lib/harness", () => ({
  getActiveHarness: activeHarness,
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: vi.fn(async () => ""),
  hermesConfigGetMany: vi.fn(async () => ({})),
  invalidateHermesConfigCache: vi.fn(),
}));

import { hermesSkillsGuard } from "@/lib/hermes-skills-server";
import { openclawAppsGuard } from "@/lib/openclaw-apps-server";
import { ApiError } from "../../../mcp/lib/errors";
import { registerSkillTools } from "../../../mcp/tools/skills";
import { registerDesktopTools } from "../../../mcp/tools/desktop";
import type { McpContext } from "../../../mcp/lib/context";
import { captureRegistrar } from "../helpers/mcp-registrar";

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  activeHarness.mockReset();
});

// ── The guards' own answers ──────────────────────────────────────────────────

describe("the edition guards — a refusal has to be tellable from a missing id", () => {
  it("hermesSkillsGuard labels its 404 so a caller can tell it from a resource 404", async () => {
    activeHarness.mockResolvedValue("openclaw");
    const res = await hermesSkillsGuard();
    expect(res).not.toBeNull();
    if (!res) return;
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string; code?: string };
    // The status and the human string are unchanged — the browser and
    // src/middleware.ts must see exactly what they saw before — but the
    // machine-readable reason is now on the wire.
    expect(body.error).toBe("Not found");
    expect(body.code).toBe("not_hermes");
  });

  it("openclawAppsGuard labels its 404 the same way", async () => {
    activeHarness.mockResolvedValue("hermes");
    const res = await openclawAppsGuard();
    expect(res).not.toBeNull();
    if (!res) return;
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBe("Not found");
    expect(body.code).toBe("not_openclaw");
  });

  it("neither guard answers at all on its own harness", async () => {
    activeHarness.mockResolvedValue("hermes");
    expect(await hermesSkillsGuard()).toBeNull();
    activeHarness.mockResolvedValue("openclaw");
    expect(await openclawAppsGuard()).toBeNull();
  });
});

// ── Every guarded tool decodes it the same way ───────────────────────────────

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

describe("the guarded tools — an edition-guard 404 is not a bad id", () => {
  /** Exactly what the guards put on the wire. */
  const guard404 = (code: "not_hermes" | "not_openclaw") =>
    new ApiError(404, JSON.stringify({ error: "Not found", code }));

  const guardEverything = (code: "not_hermes" | "not_openclaw") => {
    apiGet.mockRejectedValue(guard404(code));
    apiPost.mockRejectedValue(guard404(code));
  };

  function skills() {
    const h = captureRegistrar("hermes");
    registerSkillTools(h.reg);
    return h;
  }

  function desktop() {
    const h = captureRegistrar("openclaw");
    registerDesktopTools(h.reg, ctx("openclaw"));
    return h;
  }

  // Every tool that reaches a guarded route, with an argument set that passes
  // its own local validation — so the 404 is the only thing under test.
  const CASES: {
    tool: string;
    args: Record<string, unknown>;
    code: "not_hermes" | "not_openclaw";
    harness: RegExp;
  }[] = [
    {
      tool: "skill_search",
      args: { query: "pdf", sort: "relevance", limit: 5 },
      code: "not_hermes",
      harness: /hermes harness/i,
    },
    { tool: "skill_list", args: {}, code: "not_hermes", harness: /hermes harness/i },
    { tool: "skill_info", args: { id: "official/pdf" }, code: "not_hermes", harness: /hermes harness/i },
    {
      tool: "skill_install",
      args: { id: "official/pdf", confirm: false },
      code: "not_hermes",
      harness: /hermes harness/i,
    },
    { tool: "skill_uninstall", args: { name: "pdf" }, code: "not_hermes", harness: /hermes harness/i },
    { tool: "app_search", args: { limit: 5 }, code: "not_openclaw", harness: /openclaw harness/i },
    { tool: "app_install", args: { app_id: "notes" }, code: "not_openclaw", harness: /openclaw harness/i },
  ];

  it.each(CASES)("$tool says the harness is wrong, not the id", async ({ tool, args, code, harness }) => {
    guardEverything(code);
    const h = code === "not_hermes" ? skills() : desktop();
    const out = await h.call(tool, args);

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_SUPPORTED_HERE");
    expect(out.error.message).toMatch(harness);
    expect(out.error.next).toMatch(/do not retry/i);
    // Every recovery the old wording offered goes back through the same guard.
    expect(out.error.next).not.toMatch(/skill_list|skill_search|app_search|ui_list_apps|code_project_list/);
    expect(out.error.message).not.toMatch(
      /no skill with that id|not a valid|could not find what this tool was pointed at/i,
    );
  });

  /**
   * The two halves of this fix live in different packages — the route under
   * src/, the rule under mcp/ — and nothing but a shared string literal joins
   * them. So take the guard's REAL response body off the wire and feed it to
   * the tool, rather than retyping what we hope it says.
   */
  it("decodes the body the guard actually sends, not a hand-written copy", async () => {
    activeHarness.mockResolvedValue("openclaw");
    const guardRes = await hermesSkillsGuard();
    expect(guardRes).not.toBeNull();
    if (!guardRes) return;
    const wire = await guardRes.text();

    apiGet.mockRejectedValue(new ApiError(404, wire));
    const out = await skills().call("skill_list", {});
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_SUPPORTED_HERE");

    activeHarness.mockResolvedValue("hermes");
    const appsRes = await openclawAppsGuard();
    expect(appsRes).not.toBeNull();
    if (!appsRes) return;
    apiGet.mockRejectedValue(new ApiError(404, await appsRes.text()));
    const appOut = await desktop().call("app_search", { limit: 5 });
    expect(appOut.isError).toBe(true);
    if (!appOut.isError) return;
    expect(appOut.error.code).toBe("NOT_SUPPORTED_HERE");
  });

  it("still reads a LABELLED not_installed 404 as a missing skill", async () => {
    // Anti-shadowing: the edition rule sits first in every list, so it must not
    // swallow the refusal #513 added.
    apiGet.mockRejectedValue(new ApiError(502, "{}"));
    apiPost.mockRejectedValue(
      new ApiError(404, JSON.stringify({ error: "not installed", code: "not_installed" })),
    );

    const out = await skills().call("skill_uninstall", { name: "ghost" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.message).toMatch(/no installed skill called "ghost"/i);
  });

  it("still reads an UNLABELLED 404 from a store route as a missing app id", async () => {
    // The other half of the same coin: a store route can 404 for an id it does
    // not have, and that one really is the agent's to fix.
    apiGet.mockRejectedValue(new ApiError(404, JSON.stringify({ error: "App not found" })));
    const out = await desktop().call("app_search", { limit: 5 });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.message).not.toMatch(/harness/i);
  });
});

// ── Anti-drift ───────────────────────────────────────────────────────────────

describe("no guarded call may bypass its edition rule", () => {
  /**
   * The bug this file closes existed because the rule lists were per-call-site
   * and four of the seven skills call sites (installedSkills(), skill_list, the
   * inspect docs phase, and the uninstall POST before #513) carried no rule for
   * this at all. Routing every call through the two local wrappers is what
   * makes "we found them all" checkable rather than claimed.
   */
  it("reaches the skills routes only through skillsGet/skillsPost", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "mcp/tools/skills.ts"), "utf-8");
    const bare = src.match(/(?<![A-Za-z])api(?:Get|Post)\s*</g) ?? [];
    // The two wrapper definitions are the only permitted uses.
    expect(bare.length).toBe(2);
    expect(src).not.toMatch(/(?<![A-Za-z])api(?:Get|Post)\s*\(\s*["']\/setup-api/);
  });

  /**
   * desktop.ts has only two calls behind openclawAppsGuard() and several that
   * are deliberately NOT guarded (apps/uninstall, apps/icon), so a blanket
   * wrapper would be the wrong shape there. This is the check that keeps the
   * two guarded ones honest instead.
   */
  it("passes the store edition rule on every call to a guarded apps route", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "mcp/tools/desktop.ts"), "utf-8");
    const GUARDED = ["/setup-api/apps/store", "/setup-api/apps/install"];
    for (const route of GUARDED) {
      const at = src.indexOf(`"${route}"`);
      expect(at, `${route} is no longer called from desktop.ts`).toBeGreaterThan(-1);
      // The options object of that call, up to the end of the statement.
      const stmt = src.slice(at, src.indexOf(");", at));
      expect(stmt, `${route} does not pass STORE_EDITION_RULE`).toContain("STORE_EDITION_RULE");
    }
  });
});
