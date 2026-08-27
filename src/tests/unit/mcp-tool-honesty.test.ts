import fs from "fs";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-453 — MCP tools that reported success for things that did not happen,
 * or pointed the agent at a next step it could not follow.
 *
 * Every case below was observed live on a Hermes device. The shared failure
 * mode is that an HTTP 200 was taken as proof: the uninstall route answers
 * {"ok":true} for a skill the CLI refused to remove, the inspect route
 * synthesises a record for any well-formed id, the backup route answers 200
 * with ok:false, and the ClawKeep status route answers 200 with
 * supportedOnEdition:false. A small model has no way to recover from a tool
 * that says "done" — it moves on and tells the user it is done.
 */

const { HOME, apiGet, apiPost, apiTry, spawnArgv, hasBinary } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("os") as typeof import("os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("path") as typeof import("path");
  return {
    HOME: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "clawbox-mcp-honesty-")),
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiTry: vi.fn(),
    spawnArgv: vi.fn(),
    hasBinary: vi.fn(),
  };
});

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
    apiTry: (...a: unknown[]) => apiTry(...a),
    API_BASE: "http://127.0.0.1:80",
    CLAWBOX_ROOT: "/home/clawbox/clawbox",
  };
});

vi.mock("../../../mcp/lib/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../mcp/lib/guard")>();
  return { ...actual, HOME, spawnArgv, hasBinary };
});

import { ApiError, classifyError } from "../../../mcp/lib/errors";
import type { McpContext } from "../../../mcp/lib/context";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerAiTools } from "../../../mcp/tools/ai";
import { registerBrowserTools } from "../../../mcp/tools/browser";
import { registerSkillTools } from "../../../mcp/tools/skills";
import { buildContext } from "../../../mcp/lib/context";
import { registerOrientationTools } from "../../../mcp/tools/orientation";
import { desktopDisplay, registerSystemTools } from "../../../mcp/tools/system";

const ctx = (
  edition: "openclaw" | "hermes",
  providers: string[] = [],
  overrides: Partial<McpContext> = {},
): McpContext => ({
  edition,
  install: edition,
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: false },
  providers,
  // The probe defaults, spelled out rather than left off: every one of these
  // decides whether a tool is registered at all, and a helper that omitted them
  // was a helper the type checker had already stopped believing.
  emailCanRead: false,
  codingAgent: false,
  canGenerateImages: true,
  ...overrides,
});

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiTry.mockReset().mockResolvedValue(null);
  spawnArgv.mockReset();
  hasBinary.mockReset();
  delete process.env.CLAWBOX_VNC_DISPLAY;
  delete process.env.DISPLAY;
});

afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

// ── skill_uninstall ──────────────────────────────────────────────────────────

describe("skill_uninstall — a 200 is not proof anything was removed", () => {
  function skills() {
    const h = captureRegistrar("hermes");
    registerSkillTools(h.reg);
    return h;
  }

  const installed = (list: { name: string; origin?: string; identifier?: string }[]) =>
    apiGet.mockResolvedValue({ skills: list });

  it("refuses a name the device has never installed, instead of reporting success", async () => {
    installed([{ name: "pdf", origin: "hub" }]);
    const out = await skills().call("skill_uninstall", { name: "no-such-skill" });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/skill_list/);
    // And it never reached the route, so nothing was even attempted.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("refuses a built-in skill, which the harness silently declines to remove", async () => {
    installed([{ name: "memo", origin: "builtin" }]);
    const out = await skills().call("skill_uninstall", { name: "memo" });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/came with the device/i);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("reports failure when the skill is still installed afterwards", async () => {
    installed([{ name: "pdf", origin: "hub" }]);
    apiPost.mockResolvedValue({ ok: true, id: "pdf", name: "pdf" });

    const out = await skills().call("skill_uninstall", { name: "pdf" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/still installed/i);
    expect(out.error.next).toMatch(/do not retry/i);
  });

  it("still reports success when the skill really is gone", async () => {
    apiGet
      .mockResolvedValueOnce({ skills: [{ name: "pdf", origin: "hub" }] })
      .mockResolvedValueOnce({ skills: [] });
    apiPost.mockResolvedValue({ ok: true });

    const out = await skills().call("skill_uninstall", { name: "pdf" });
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toContain("Removed the skill \"pdf\"");
  });

  /**
   * TASK-453 round 2 — the inverse bug the post-condition introduced.
   *
   * A store skill can SHADOW a builtin of the same name; the README's own
   * worked example is exactly that (`skill_install official/pdf` ->
   * `skill_uninstall pdf`). The installed list is keyed by name, so removing
   * the store copy does not empty the name — the builtin underneath resurfaces
   * with origin "builtin". Live on the QA box the removal SUCCEEDED on disk and
   * the tool still answered CONFLICT "The device did not remove \"pdf\"".
   */
  it("reports success when removing a store skill that was shadowing a builtin", async () => {
    apiGet
      .mockResolvedValueOnce({
        skills: [{ name: "pdf", origin: "hub", identifier: "openai/skills/skills/.curated/pdf" }],
      })
      // The hub entry is gone; the bundled `pdf` is back under the same name.
      .mockResolvedValueOnce({ skills: [{ name: "pdf", origin: "builtin" }] });
    apiPost.mockResolvedValue({ ok: true });

    const out = await skills().call("skill_uninstall", { name: "pdf" });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/Removed the store skill "pdf"/);
    // And the agent is told why the name is still in skill_list.
    expect(out.text).toMatch(/built-in "pdf" .* available again/);
  });

  it("still reports failure when the SAME store skill survives the uninstall", async () => {
    const entry = { name: "pdf", origin: "hub", identifier: "openai/skills/skills/.curated/pdf" };
    apiGet.mockResolvedValueOnce({ skills: [entry] }).mockResolvedValueOnce({ skills: [entry] });
    apiPost.mockResolvedValue({ ok: true });

    const out = await skills().call("skill_uninstall", { name: "pdf" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/still installed/i);
  });

  it("prefers the removable store row when a builtin of the same name is listed too", async () => {
    apiGet
      .mockResolvedValueOnce({
        skills: [
          { name: "pdf", origin: "builtin" },
          { name: "pdf", origin: "hub", identifier: "openai/skills/skills/.curated/pdf" },
        ],
      })
      .mockResolvedValueOnce({ skills: [{ name: "pdf", origin: "builtin" }] });
    apiPost.mockResolvedValue({ ok: true });

    const out = await skills().call("skill_uninstall", { name: "pdf" });
    // The builtin row must not make this look unremovable before the POST.
    expect(out.isError).toBe(false);
    expect(apiPost).toHaveBeenCalled();
  });

  it("does not block the uninstall when the installed list cannot be read", async () => {
    apiGet.mockRejectedValue(new ApiError(502, "{}"));
    apiPost.mockResolvedValue({ ok: true });

    const out = await skills().call("skill_uninstall", { name: "pdf" });
    expect(out.isError).toBe(false);
    expect(apiPost).toHaveBeenCalled();
  });

  /**
   * MCP-02 — the pre-condition above is the ONLY thing that normally decodes
   * "there is no such skill" and "that one is built in", and it is skipped
   * whenever the installed list cannot be read (installedSkills() swallows any
   * failure and returns null). In that window the route's own structured
   * refusals are all the agent gets, and neither had a rule: the 404 became the
   * generic resource-404 and the 409 became a generic CONFLICT whose next step
   * was "ask them to finish the setup in Settings" — advice that cannot make a
   * built-in skill removable.
   */
  describe("the route's own refusals, when the pre-condition could not run", () => {
    /** The installed list is unreadable, so the route's answer is the whole story. */
    const blindfolded = () => apiGet.mockRejectedValue(new ApiError(502, "{}"));
    const routeSays = (status: number, body: Record<string, string>) =>
      apiPost.mockRejectedValue(new ApiError(status, JSON.stringify(body)));

    it("reports a built-in skill as built in, not as unfinished setup", async () => {
      blindfolded();
      routeSays(409, {
        error: '"memo" came with this device, so it cannot be removed.',
        code: "builtin_skill",
      });

      const out = await skills().call("skill_uninstall", { name: "memo" });
      expect(out.isError).toBe(true);
      if (!out.isError) return;
      expect(out.error.code).toBe("CONFLICT");
      expect(out.error.message).toMatch(/came with the device/i);
      expect(out.error.next).toMatch(/built in/i);
      expect(out.error.next).toMatch(/do not retry/i);
      // The generic 409 sent the agent to Settings. There is nothing to finish
      // there, and the skill will still be built in when it comes back.
      expect(out.error.next).not.toMatch(/settings/i);
    });

    it("reports a name the device does not have as not installed", async () => {
      blindfolded();
      routeSays(404, {
        error: 'No store skill called "ghost" is installed on this device.',
        code: "not_installed",
      });

      const out = await skills().call("skill_uninstall", { name: "ghost" });
      expect(out.isError).toBe(true);
      if (!out.isError) return;
      expect(out.error.code).toBe("NOT_FOUND");
      expect(out.error.message).toMatch(/no installed skill called "ghost"/i);
      expect(out.error.next).toMatch(/skill_list/);
      expect(out.error.next).toMatch(/do not retry this name/i);
      // The generic resource-404 offered tools that have nothing to do with skills.
      expect(out.error.next).not.toMatch(/ui_list_apps|code_project_list/);
    });

    /**
     * The edition gate answers 404 from the SAME route, with no `code`. The
     * tool is registered off a probe taken once at startup, so a device that
     * switched harness since then reaches this branch — and "no such skill is
     * installed" would be a confident answer to a question nobody asked.
     */
    it("does not read the Hermes edition guard's 404 as a missing skill", async () => {
      blindfolded();
      routeSays(404, { error: "Not found" });

      const out = await skills().call("skill_uninstall", { name: "pdf" });
      expect(out.isError).toBe(true);
      if (!out.isError) return;
      expect(out.error.message).not.toMatch(/no installed skill called/i);
    });

    /**
     * Anti-drift: the same device state has to produce the same sentence
     * whichever path noticed it, or the agent gets two stories about one fact.
     */
    it("says the same thing as the pre-condition for the same device state", async () => {
      installed([{ name: "memo", origin: "builtin" }]);
      const viaPrecondition = await skills().call("skill_uninstall", { name: "memo" });

      apiGet.mockReset();
      blindfolded();
      routeSays(409, {
        error: '"memo" came with this device, so it cannot be removed.',
        code: "builtin_skill",
      });
      const viaRoute = await skills().call("skill_uninstall", { name: "memo" });

      expect(viaPrecondition.isError).toBe(true);
      expect(viaRoute.isError).toBe(true);
      if (!viaPrecondition.isError || !viaRoute.isError) return;
      expect(viaRoute.error).toEqual(viaPrecondition.error);
    });
  });
});

// ── skill_info ───────────────────────────────────────────────────────────────

describe("skill_info — a synthesised record is not a skill", () => {
  function skills() {
    const h = captureRegistrar("hermes");
    registerSkillTools(h.reg);
    return h;
  }

  /** Exactly what the live inspect route returns for an id nobody has heard of. */
  const FABRICATED = {
    skill: {
      id: "official/nonexistent-xyz",
      name: "nonexistent-xyz",
      provenance: { sourceUrlVerified: false },
      bodySource: "none",
      bodyTruncated: false,
      needsRemoteDocs: true,
    },
  };

  it("reports NOT_FOUND rather than inventing a skill", async () => {
    // Phase 1 fabricates; phase 2 (the CLI) adds nothing.
    apiGet.mockResolvedValueOnce(FABRICATED).mockResolvedValueOnce({ delta: {} });

    const out = await skills().call("skill_info", { id: "official/nonexistent-xyz" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/skill_search/);
  });

  it("accepts the same shell of a record once the CLI fills the documentation in", async () => {
    apiGet
      .mockResolvedValueOnce(FABRICATED)
      .mockResolvedValueOnce({ delta: { description: "Reads PDFs", body: "# PDF\n" } });

    const out = await skills().call("skill_info", { id: "official/nonexistent-xyz" });
    expect(out.isError).toBe(false);
  });

  it("says works_here is unknown when the device never checked", async () => {
    apiGet.mockResolvedValue({
      skill: { id: "official/pdf", name: "pdf", description: "Reads PDFs", source: "official", trust: "official" },
    });

    const out = await skills().call("skill_info", { id: "official/pdf" });
    if (out.isError) throw new Error("skill_info failed");
    expect(JSON.parse(out.text).works_here).toBe("unknown");
  });

  it("still reports a real incompatibility as false", async () => {
    apiGet.mockResolvedValue({
      skill: { id: "official/mac", name: "mac", description: "macOS only", source: "official", incompatible: true },
    });

    const out = await skills().call("skill_info", { id: "official/mac" });
    if (out.isError) throw new Error("skill_info failed");
    expect(JSON.parse(out.text).works_here).toBe(false);
  });
});

// ── ai_list_models ───────────────────────────────────────────────────────────

describe("ai_list_models — what is in use, and what fits", () => {
  function ai(providers: string[] = []) {
    const h = captureRegistrar("hermes");
    registerAiTools(h.reg, ctx("hermes", providers));
    return h;
  }

  const CATALOGUE = {
    provider: "clawlocal",
    current: "llama3.2:3b",
    reasoning: "minimal",
    models: [{ id: "llama3.2:3b" }],
    providers: [
      { id: "clawlocal", name: "Local", authenticated: true, total: 3 },
      { id: "zai", name: "Z.ai", authenticated: true, total: 3 },
      ...Array.from({ length: 45 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, authenticated: false, total: 8 })),
    ],
  };

  it("does not report the provider you asked about as the one in use", async () => {
    // The route reuses the `provider` field for the filter it was given.
    apiGet.mockResolvedValue({ provider: "zai", current: "", models: [{ id: "glm-4" }], providers: [] });

    const out = await ai().call("ai_list_models", { provider: "zai" });
    if (out.isError) throw new Error("ai_list_models failed");
    const body = JSON.parse(out.text);
    expect(body.asked_about).toBe("zai");
    expect(JSON.stringify(body.in_use)).not.toMatch(/"provider"\s*:\s*"zai"/);
    expect(String(body.in_use)).toMatch(/ai_list_models with no arguments/);
  });

  it("reports the real provider and model on an unfiltered call", async () => {
    apiGet.mockResolvedValue(CATALOGUE);
    const out = await ai().call("ai_list_models", {});
    if (out.isError) throw new Error("ai_list_models failed");
    expect(JSON.parse(out.text).in_use).toEqual({ provider: "clawlocal", model: "llama3.2:3b" });
  });

  /**
   * TASK-453 round 2. `/setup-api/hermes/models` answers with EMPTY STRINGS,
   * not null, on a device where nothing has been configured yet, so `??` never
   * fired and the tool returned `{"in_use":{"provider":"","model":""},
   * "thinking":""}` — observed live on a box whose data/config.json had no
   * provider or model key at all. Two blanks are an invitation to a small model
   * to fill them in; "unknown" is not.
   */
  it("says unknown, not an empty string, when nothing is configured", async () => {
    apiGet.mockResolvedValue({
      provider: "",
      current: "",
      reasoning: "",
      models: [{ id: "glm-4" }],
      providers: [],
    });

    const out = await ai().call("ai_list_models", {});
    if (out.isError) throw new Error("ai_list_models failed");
    const body = JSON.parse(out.text);
    expect(body.in_use).toEqual({ provider: "unknown", model: "unknown" });
    expect(body.thinking).toBe("unknown");
  });

  it("treats a whitespace-only field as unreported too", async () => {
    apiGet.mockResolvedValue({ provider: "  ", current: "\t", reasoning: " ", models: [], providers: [] });
    const out = await ai().call("ai_list_models", {});
    if (out.isError) throw new Error("ai_list_models failed");
    expect(JSON.parse(out.text).in_use).toEqual({ provider: "unknown", model: "unknown" });
  });

  /**
   * The output cap slices from the END, so a 48-provider directory pushed the
   * `models` array — the answer to the question — entirely past the cut.
   */
  it("keeps the models inside the tool's output cap", async () => {
    apiGet.mockResolvedValue(CATALOGUE);
    const h = ai();
    const out = await h.call("ai_list_models", {});
    if (out.isError) throw new Error("ai_list_models failed");

    const cap = h.get("ai_list_models").opts.maxChars ?? 4_000;
    expect(out.text.length).toBeLessThanOrEqual(cap);
    expect(out.text.indexOf("\"models\"")).toBeLessThan(out.text.indexOf("\"providers\""));
    expect(JSON.parse(out.text).models).toEqual([{ id: "llama3.2:3b" }]);
  });

  it("summarises the providers that have no credentials instead of listing them", async () => {
    apiGet.mockResolvedValue(CATALOGUE);
    const out = await ai().call("ai_list_models", {});
    if (out.isError) throw new Error("ai_list_models failed");
    const body = JSON.parse(out.text);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["clawlocal", "zai"]);
    expect(body.providers_without_credentials).toBe(45);
  });
});

// ── browser_open ─────────────────────────────────────────────────────────────

describe("browser_open — a refused address is not a dead browser", () => {
  function browser() {
    const h = captureRegistrar("hermes");
    registerBrowserTools(h.reg);
    return h;
  }

  it("reports the SSRF refusal as an argument problem", async () => {
    apiPost.mockRejectedValue(new ApiError(400, JSON.stringify({ error: "Blocked internal address" })));

    const out = await browser().call("browser_open", { url: "http://127.0.0.1/login" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.message).toMatch(/private network/i);
    // The retry loop: browser_open's own failure used to tell the agent to
    // call browser_open.
    expect(out.error.next).not.toMatch(/call browser_open/i);
  });

  it("still reports a genuinely dead browser as ENDPOINT_DOWN", async () => {
    apiPost.mockRejectedValue(new Error("fetch failed"));

    const out = await browser().call("browser_open", { url: "https://example.com" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("ENDPOINT_DOWN");
    // browser_open may name itself only to say "stop calling me".
    expect(out.error.next).toMatch(/do not call browser_open again/i);
  });

  it("keeps telling the OTHER browser tools to open the browser first", async () => {
    apiPost.mockRejectedValue(new Error("fetch failed"));

    const out = await browser().call("browser_navigate", { url: "https://example.com" });
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.next).toMatch(/browser_open/);
  });
});

// ── 404 mapping ──────────────────────────────────────────────────────────────

describe("404 mapping — the id or the edition", () => {
  it("sends a missing resource back to the listing tools, not device_status", () => {
    const e = classifyError(new ApiError(404, JSON.stringify({ error: "Webapp not found" })), "webapp_update");
    expect(e.code).toBe("NOT_FOUND");
    expect(e.next).toMatch(/ui_list_apps/);
    expect(e.next).not.toMatch(/device_status/);
  });

  it("keeps the edition wording for a route this build does not have", () => {
    const e = classifyError(
      new ApiError(404, "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>"),
      "app_search",
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(e.next).toMatch(/device_status/);
  });

  it("treats an empty body as the route case", () => {
    expect(classifyError(new ApiError(404, ""), "app_search").next).toMatch(/device_status/);
  });
});

// ── ClawKeep ─────────────────────────────────────────────────────────────────

describe("ClawKeep is gated on the edition that can actually run it", () => {
  function system(edition: "openclaw" | "hermes") {
    const h = captureRegistrar(edition);
    registerSystemTools(h.reg, ctx(edition));
    return h;
  }

  it("does not offer the write and list backup tools on Hermes", () => {
    const h = system("hermes");
    expect(h.has("backup_now")).toBe(false);
    expect(h.has("backup_list")).toBe(false);
    // Kept, so the agent can answer "do you back up?" instead of going silent.
    expect(h.has("backup_status")).toBe(true);
  });

  it("offers all three on OpenClaw, where ClawKeep runs", () => {
    const h = system("openclaw");
    expect(h.has("backup_now")).toBe(true);
    expect(h.has("backup_list")).toBe(true);
    expect(h.has("backup_status")).toBe(true);
  });

  it("answers backup_status honestly when the edition cannot run ClawKeep", async () => {
    // HTTP 200 — which is why the existing 404-only NOT_SUPPORTED_HERE rule
    // never fired and the agent read this as "not paired yet".
    apiGet.mockResolvedValue({ paired: false, configured: false, supportedOnEdition: false });

    const out = await system("hermes").call("backup_status", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/not available on this edition/i);
    expect(out.text).toMatch(/do not call any backup tool again/i);
    expect(out.text).not.toMatch(/Settings -> Backup/);
  });

  it("still reports the real status where ClawKeep is supported", async () => {
    apiGet.mockResolvedValue({ paired: true, configured: true, supportedOnEdition: true });
    const out = await system("openclaw").call("backup_status", {});
    if (out.isError) throw new Error("backup_status failed");
    expect(JSON.parse(out.text).paired).toBe(true);
  });

  it("reports a failed backup as a failure, with the reason the route carried", async () => {
    // The route answers 200 with ok:false, so nothing ever threw.
    apiPost.mockResolvedValue({
      exitCode: 1,
      ok: false,
      stdoutTail: "",
      stderrTail: "token error: No token at ~/.clawkeep/token; run 'clawkeep pair' first",
    });

    const out = await system("openclaw").call("backup_now", {});
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).toMatch(/did not run/i);
    expect(out.error.message).toMatch(/clawkeep pair/);
    expect(out.error.next).toMatch(/do not start another one/i);
  });

  it("reports a successful backup as one", async () => {
    apiPost.mockResolvedValue({ exitCode: 0, ok: true });
    const out = await system("openclaw").call("backup_now", {});
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/finished successfully/i);
  });
});

// ── screen_capture ───────────────────────────────────────────────────────────

describe("screen_capture photographs the screen the user is looking at", () => {
  const markerDir = path.join(HOME, ".cache", "clawbox");
  const marker = path.join(markerDir, "vnc-display.env");

  it("prefers the display the VNC stack recorded over the X default", async () => {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, "CLAWBOX_VNC_DISPLAY=:99\n");
    // The MCP is spawned with no DISPLAY at all, which is how :0 — a 640x480
    // headless stub — used to win.
    await expect(desktopDisplay()).resolves.toBe(":99");
    fs.rmSync(marker);
  });

  it("honours an explicit override ahead of the marker", async () => {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, "CLAWBOX_VNC_DISPLAY=:99\n");
    process.env.CLAWBOX_VNC_DISPLAY = ":7";
    await expect(desktopDisplay()).resolves.toBe(":7");
    fs.rmSync(marker);
  });

  it("falls back to the X default when nothing on the device says otherwise", async () => {
    await expect(desktopDisplay()).resolves.toBe(":0");
  });
});

// ── ai_set_provider ──────────────────────────────────────────────────────────

describe("ai_set_provider is not a one-way door", () => {
  it("keeps the configured provider reachable even when the catalogue omits it", async () => {
    // `auto` is a Hermes CLI meta-provider: the route accepts it, and it can
    // never appear in the credentialed catalogue the enum is built from. The
    // agent could switch away from it and then had no value to switch back to.
    hasBinary.mockResolvedValue(false);
    spawnArgv.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", timedOut: false });
    apiTry.mockResolvedValue({
      provider: "auto",
      providers: [{ id: "zai", authenticated: true }, { id: "openai", authenticated: false }],
    });

    const built = await buildContext("hermes", "hermes", "full");
    expect(built.providers).toContain("auto");
    expect(built.providers).toContain("zai");
    expect(built.providers).not.toContain("openai");
  });

  it("does not duplicate a configured provider the catalogue already lists", async () => {
    hasBinary.mockResolvedValue(false);
    spawnArgv.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "", timedOut: false });
    apiTry.mockResolvedValue({
      provider: "clawlocal",
      providers: [{ id: "clawlocal", authenticated: true }],
    });

    const built = await buildContext("hermes", "hermes", "full");
    expect(built.providers).toEqual(["clawlocal"]);
  });
});

// ── Drawing, on a box that cannot ────────────────────────────────────────────
//
// Image generation on this device is not a ClawBox MCP tool at all: on Hermes
// it is a native plugin installed by LINKING ClawBox AI, on OpenClaw it is the
// agent's own bundled tool spending the same credential. So an unlinked box has
// no image tool anywhere, and an agent asked for a picture found nothing and
// improvised — observed on the owner's box (2026-08-26): `write_file` an SVG
// into its working directory, `pip install cairosvg`, rasterise, and hand back
// a path the chat cannot serve. The customer got a broken thumbnail and no
// explanation.
//
// So the absence gets a voice, the way `backup_status` gives one to ClawKeep's:
// one tool, registered only where drawing is impossible, whose whole job is to
// be found and to say why.

describe("a box that cannot draw says so instead of improvising", () => {
  function ai(edition: "openclaw" | "hermes", canGenerateImages: boolean) {
    const h = captureRegistrar(edition);
    registerAiTools(h.reg, ctx(edition, [], { canGenerateImages }));
    return h;
  }

  it("registers nothing extra where the box CAN draw", () => {
    // The harness's own image tool is present there, and a second tool beside
    // it saying "you cannot" is worse than silence.
    expect(ai("hermes", true).has("image_generate")).toBe(false);
    expect(ai("openclaw", true).has("image_generate")).toBe(false);
  });

  it("offers the refusal on both editions when the box cannot draw", () => {
    expect(ai("hermes", false).has("image_generate")).toBe(true);
    expect(ai("openclaw", false).has("image_generate")).toBe(true);
  });

  it("survives the core profile, which is where it matters most", () => {
    // `CLAWBOX_MCP_PROFILE=core` is the trimmed set a SMALL model gets, and a
    // small model is the likeliest to answer "draw me a crab" with the shell.
    // A tool that is dropped from core is missing from exactly those boxes.
    expect(ai("hermes", false).get("image_generate").opts.profile).toBe("core");
  });

  it("names the reason, the fix, and closes the door the agent walked through", async () => {
    const out = await ai("hermes", false).call("image_generate", {});
    // Not an error: a tool that throws trips Hermes' circuit breaker, and this
    // one has something true to say.
    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/ClawBox AI/);
    expect(out.text).toMatch(/Settings -> AI Providers/);
    // The improvisation itself, named — this is the half that stops the
    // hand-written-SVG answer coming back.
    expect(out.text).toMatch(/terminal/i);
    expect(out.text).toMatch(/SVG/i);
  });

  it("is discoverable from the description alone, before it is ever called", () => {
    // A small model decides whether to call a tool from its description. If it
    // does not read as "this is how you make a picture", the model never gets
    // as far as the honest answer inside.
    const { description } = ai("hermes", false).get("image_generate");
    expect(description).toMatch(/picture|image/i);
  });
});

// ── skill_install ────────────────────────────────────────────────────────────

/**
 * TASK-453 round 3. `hermes skills install` exits 0 on every refusal, so the
 * install route used to answer "Skill could not be resolved" for all of them,
 * and this decoder turned that into `NOT_FOUND` + "Call skill_search, then pass
 * the exact id it returned" — the step the agent had just taken. Live on a
 * Hermes box, every ClawHub id sampled came back that way, so the loop was
 * guaranteed for three quarters of the store.
 *
 * The route now names which refusal happened. What matters here is that each
 * one gets a next step the agent CAN follow, and that the one the agent must
 * not act on — a refusal no confirmation overrides — never sends it back round.
 */
describe("skill_install — a refusal the agent can act on", () => {
  function skills() {
    const h = captureRegistrar("hermes");
    registerSkillTools(h.reg);
    return h;
  }

  const refuse = (status: number, body: Record<string, unknown>) =>
    apiPost.mockRejectedValue(new ApiError(status, JSON.stringify(body)));

  async function installErr(id = "oo-terraform") {
    const out = await skills().call("skill_install", { id, confirm: false });
    if (!out.isError) throw new Error("expected skill_install to refuse");
    return out.error;
  }

  it("does not send the agent back to skill_search when the DEVICE blocked the skill", async () => {
    refuse(409, {
      error: 'The device refused to install "oo-terraform".',
      code: "dangerous_skill_blocked",
      requiresConfirmation: false,
      overridable: false,
      warning: {
        verdict: "dangerous",
        trust: "community",
        capabilities: [{ id: "shell" }, { id: "credentials" }],
      },
    });

    const e = await installErr();

    expect(e.code).toBe("CONFLICT");
    // The exact loop that was live: "pass the exact id it returned" is what had
    // just been done.
    expect(e.next).not.toMatch(/skill_search, then pass the exact id/);
    expect(e.next).toMatch(/do NOT retry/i);
    // And it must not offer a confirmation that cannot work.
    expect(e.next).not.toMatch(/confirm=true/);
    // It says what the skill can do, in words a user understands.
    expect(e.message).toMatch(/run commands on the device/);
    expect(e.message).toMatch(/read saved keys/);
  });

  it("still asks the user when the device's refusal IS confirmable", async () => {
    refuse(409, {
      error: "This skill did not pass the device's security scan.",
      code: "dangerous_skill",
      requiresConfirmation: true,
      warning: { verdict: "caution", capabilities: [{ id: "network" }] },
    });

    const e = await installErr();

    expect(e.next).toMatch(/confirm=true/);
  });

  it("keeps 'that id did not resolve' for the case where it is true, and passes the suggestions on", async () => {
    refuse(502, {
      error: "Skill could not be resolved — try the full identifier",
      code: "unresolved",
      candidates: ["oo-terraform"],
    });

    const e = await installErr();

    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toMatch(/oo-terraform/);
  });

  it("tells the agent to wait, not to retry, when the GitHub allowance is gone", async () => {
    refuse(502, { error: "the hourly GitHub API allowance is gone.", code: "rate_limited" });

    const e = await installErr();

    expect(e.code).toBe("CONFLICT");
    expect(e.next).toMatch(/hour/i);
  });

  it("does not report an unfinished install as a missing id", async () => {
    // This branch was unreachable: an ErrorRule for status 502 is applied
    // inside api() and always won before the body was ever looked at.
    refuse(502, {
      error: "The download was incomplete — the skill was not installed.",
      code: "incomplete_install",
      missingFiles: ["reference/pdf.md"],
    });

    const e = await installErr();

    expect(e.message).toMatch(/incomplete/i);
    expect(e.message).toMatch(/reference\/pdf\.md/);
    expect(e.next).toMatch(/wifi_status/);
  });

  it("refuses a short name the store cannot narrow down, without inventing an id", async () => {
    refuse(409, { error: "More than one skill goes by that name.", code: "ambiguous_id" });

    const e = await installErr("pdf");

    expect(e.code).toBe("BAD_ARGUMENT");
    expect(e.next).toMatch(/FULL id/);
  });

  it("does not report an auth failure as a device refusal", async () => {
    // The catch-all for an unrecognised code is scoped to the two statuses the
    // route refuses with. A 401 has to keep classifyError's own advice: a
    // missing token is recoverable, and "do not retry" hides that.
    refuse(401, { error: "Authentication required" });

    const e = await installErr();

    expect(e.code).toBe("AUTH_FAILED");
    expect(e.next).not.toMatch(/would not install/i);
  });
});

// ── device_status ────────────────────────────────────────────────────────────

/**
 * TASK-453 round 3. `ai_list_models` was taught that /setup-api/hermes/models
 * answers with EMPTY STRINGS on an unconfigured device — but the guard went
 * into mcp/tools/ai.ts only, and device_status kept `??`. Live on a Hermes box
 * device_status answered `"provider": "", "model": "", "thinking": ""`.
 *
 * This is the worse instance of the two: the server's own instructions tell
 * every model to call device_status BEFORE answering anything about the device,
 * and to read `ai.limits` before stating any context or output limit — a key
 * the Hermes branch never emitted at all.
 */
describe("device_status — nothing read is reported as unknown", () => {
  function status(edition: "openclaw" | "hermes") {
    const h = captureRegistrar(edition);
    registerOrientationTools(h.reg, ctx(edition));
    return h;
  }

  const routes = (map: Record<string, unknown>) =>
    apiTry.mockImplementation(async (route: unknown) => map[route as string] ?? null);

  async function body(edition: "openclaw" | "hermes") {
    const out = await status(edition).call("device_status", {});
    if (out.isError) throw new Error("device_status failed");
    return JSON.parse(out.text) as { ai: Record<string, unknown> };
  }

  it("says unknown, not blank, for a Hermes device with nothing configured", async () => {
    // The exact payload the route returns on a fresh box.
    routes({ "/setup-api/hermes/models": { provider: "", current: "", reasoning: "" } });

    const { ai } = await body("hermes");

    expect(ai.provider).toBe("unknown");
    expect(ai.model).toBe("unknown");
    expect(ai.thinking).toBe("unknown");
  });

  it("emits ai.limits on Hermes, because the server's instructions tell the model to read it", async () => {
    routes({ "/setup-api/hermes/models": { provider: "", current: "", reasoning: "" } });

    const { ai } = await body("hermes");

    expect(ai).toHaveProperty("limits");
    expect(ai.limits).toBe("unknown");
  });

  it("reports what the device actually says when it says something", async () => {
    routes({
      "/setup-api/hermes/models": { provider: "clawlocal", current: "llama3.2:3b", reasoning: "minimal" },
    });

    const { ai } = await body("hermes");

    expect(ai).toMatchObject({ provider: "clawlocal", model: "llama3.2:3b", thinking: "minimal" });
  });

  it("applies the same guard to the OpenClaw branch, which reads the same shape", async () => {
    routes({ "/setup-api/chat/model": { selected: { provider: "", model: "" }, current: "" } });

    const { ai } = await body("openclaw");

    expect(ai.provider).toBe("unknown");
    expect(ai.model).toBe("unknown");
  });
});
