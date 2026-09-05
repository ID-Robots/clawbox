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
import { contractViolations } from "../../../mcp/lib/register";
import { registerAiTools } from "../../../mcp/tools/ai";
import { registerBrowserTools } from "../../../mcp/tools/browser";
import { registerSkillTools } from "../../../mcp/tools/skills";
import { buildContext } from "../../../mcp/lib/context";
import { registerOrientationTools } from "../../../mcp/tools/orientation";
import { registerDesktopTools } from "../../../mcp/tools/desktop";
import { desktopDisplay, registerSystemTools } from "../../../mcp/tools/system";

const ctx = (
  edition: "openclaw" | "hermes",
  providers: string[] = [],
  overrides: Partial<McpContext> = {},
): McpContext => ({
  edition,
  install: edition,
  appHarness: edition,
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

  const installed = (list: { id: string; name: string; origin?: string; identifier?: string }[]) =>
    apiGet.mockResolvedValue({ skills: list });

  it("refuses a name the device has never installed, instead of reporting success", async () => {
    installed([{ id: "pdf", name: "pdf", origin: "hub" }]);
    const out = await skills().call("skill_uninstall", { name: "no-such-skill" });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("NOT_FOUND");
    expect(out.error.next).toMatch(/skill_list/);
    // And it never reached the route, so nothing was even attempted.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("refuses a built-in skill, which the harness silently declines to remove", async () => {
    installed([{ id: "memo", name: "memo", origin: "builtin" }]);
    const out = await skills().call("skill_uninstall", { name: "memo" });

    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/came with the device/i);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("reports failure when the skill is still installed afterwards", async () => {
    installed([{ id: "pdf", name: "pdf", origin: "hub" }]);
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
      .mockResolvedValueOnce({ skills: [{ id: "pdf", name: "pdf", origin: "hub" }] })
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
        skills: [{ id: "pdf", name: "pdf", origin: "hub", identifier: "openai/skills/skills/.curated/pdf" }],
      })
      // The hub entry is gone; the bundled `pdf` is back under the same name.
      .mockResolvedValueOnce({ skills: [{ id: "pdf", name: "pdf", origin: "builtin" }] });
    apiPost.mockResolvedValue({ ok: true });

    const out = await skills().call("skill_uninstall", { name: "pdf" });

    expect(out.isError).toBe(false);
    if (out.isError) return;
    expect(out.text).toMatch(/Removed the store skill "pdf"/);
    // And the agent is told why the name is still in skill_list.
    expect(out.text).toMatch(/built-in "pdf" .* available again/);
  });

  it("still reports failure when the SAME store skill survives the uninstall", async () => {
    const entry = { id: "pdf", name: "pdf", origin: "hub", identifier: "openai/skills/skills/.curated/pdf" };
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
          { id: "pdf", name: "pdf", origin: "builtin" },
          { id: "pdf", name: "pdf", origin: "hub", identifier: "openai/skills/skills/.curated/pdf" },
        ],
      })
      .mockResolvedValueOnce({ skills: [{ id: "pdf", name: "pdf", origin: "builtin" }] });
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
      expect(out.error.next).toMatch(/do not retry this exact string/i);
      // The generic resource-404 offered tools that have nothing to do with skills.
      expect(out.error.next).not.toMatch(/ui_list_apps|code_project_list/);
    });

    /**
     * A 404 from this route carrying NO code at all: not the edition gate,
     * which labels its refusal `not_hermes` and is decoded as
     * NOT_SUPPORTED_HERE in mcp-skills-edition-guard.test.ts, but anything
     * else that answers 404 in front of the handler. "No such skill is
     * installed" would be a confident answer to a question nobody asked, so
     * this stays on the generic mapping.
     */
    it("does not read an unlabelled 404 as a missing skill", async () => {
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
      installed([{ id: "memo", name: "memo", origin: "builtin" }]);
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

  /**
   * What the live inspect route returns for an id nobody has heard of.
   *
   * `catalogMiss` is the route SAYING SO — nothing on this device backed the
   * record, so every field below it is a placeholder whose name is the request
   * echoed back. It was added after this test was written, and the fixture is
   * updated with it rather than left describing a wire shape no build sends:
   * the assertion is unchanged, and it is the assertion that matters.
   */
  const FABRICATED = {
    skill: {
      id: "official/nonexistent-xyz",
      name: "nonexistent-xyz",
      catalogMiss: true,
      provenance: { sourceUrlVerified: false },
      bodySource: "none",
      bodyTruncated: false,
      needsRemoteDocs: true,
    },
  };

  it("reports NOT_FOUND rather than inventing a skill", async () => {
    // Phase 1 fabricates; phase 2 is HERMES REFUSING the id — `hermes skills
    // inspect` printed neither a skill panel nor a table, which the route
    // answers 404 `not_found`. That refusal over an unbacked record is the one
    // thing that settles "this does not exist"; a docs call that merely FAILED
    // must never be read the same way.
    apiGet
      .mockResolvedValueOnce(FABRICATED)
      .mockRejectedValueOnce(new ApiError(404, JSON.stringify({ error: "Skill not found", code: "not_found" })));

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

describe("ai_list_models — the device default, and what fits", () => {
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

  it("does not report the provider you asked about as the device default", async () => {
    // The route reuses the `provider` field for the filter it was given, and
    // an empty `current` means the saved model is NOT this provider's.
    apiGet.mockResolvedValue({ provider: "zai", current: "", models: [{ id: "glm-4" }], providers: [] });

    const out = await ai().call("ai_list_models", { provider: "zai" });
    if (out.isError) throw new Error("ai_list_models failed");
    const body = JSON.parse(out.text);
    expect(body.asked_about).toBe("zai");
    expect(body.device_default).toEqual({ provider: "unknown", model: "unknown", thinking: "unknown" });
  });

  it("reports the real provider and model on an unfiltered call", async () => {
    apiGet.mockResolvedValue(CATALOGUE);
    const out = await ai().call("ai_list_models", {});
    if (out.isError) throw new Error("ai_list_models failed");
    // Under `device_default`, never `in_use` — HERMES-05, mcp-served-model-honesty.test.ts.
    expect(JSON.parse(out.text).device_default).toEqual({ provider: "clawlocal", model: "llama3.2:3b", thinking: "minimal" });
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
    expect(body.device_default).toEqual({ provider: "unknown", model: "unknown", thinking: "unknown" });
  });

  it("treats a whitespace-only field as unreported too", async () => {
    apiGet.mockResolvedValue({ provider: "  ", current: "\t", reasoning: " ", models: [], providers: [] });
    const out = await ai().call("ai_list_models", {});
    if (out.isError) throw new Error("ai_list_models failed");
    expect(JSON.parse(out.text).device_default).toEqual({ provider: "unknown", model: "unknown", thinking: "unknown" });
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

  it("keeps every system and desktop tool inside the contract check:mcp-tools enforces", () => {
    // backup_status shipped at 1002 chars on beta — over MAX_DESCRIPTION_CHARS,
    // which `npm run check:mcp-tools` fails on. No CI job runs that checker
    // (TASK-708 covers adding it) and the registrar logs a violation without
    // failing, by design, so nothing caught it. Assert the repo's own contract
    // function over the whole file rather than one tool's length: the next
    // description to grow is not going to be this one.
    //
    // Both capability postures, because four system tools register only when a
    // probe says yes — disk_usage/disk_cleanup on `du`, logs_tail on `journal`,
    // screen_capture on a grabber — and ctx()'s defaults have every probe off.
    // A guard that skips whatever a device happens to have is a guard that
    // green-lights the description it exists to catch. registerDesktopTools
    // rides along for app_uninstall, the one description written per edition.
    const postures: Partial<McpContext>[] = [
      {}, // ctx()'s own defaults: every probe off
      { capabilities: { screenGrabber: "scrot", imageConvert: true, journal: true, du: true } },
    ];
    const checked = new Set<string>();
    for (const edition of ["openclaw", "hermes"] as const) {
      for (const overrides of postures) {
        const h = captureRegistrar(edition);
        registerSystemTools(h.reg, ctx(edition, [], overrides));
        registerDesktopTools(h.reg, ctx(edition, [], overrides));
        for (const tool of h.reg.list()) {
          checked.add(tool.name);
          expect({ [tool.name]: contractViolations(tool) }).toEqual({ [tool.name]: [] });
        }
      }
    }
    // Name the probe-gated four: a gate rewritten so its tool no longer
    // registers would otherwise shrink this loop back to what it used to cover,
    // silently and while staying green.
    for (const name of ["disk_usage", "disk_cleanup", "logs_tail", "screen_capture", "app_uninstall"]) {
      expect([...checked]).toContain(name);
    }
    // What the length budget must never cost: the verdict vocabulary the
    // agent answers from.
    const desc = system("openclaw").get("backup_status").description;
    expect(desc).toMatch(/protected\|lapsed\|unprotected/);
    expect(desc).toMatch(/ok\|error\|blocked\|stale\|never/);
  });

  it("says a protected verdict with the schedule off is not a promise of a newer backup", async () => {
    // Turning auto-backup off widens the tolerated backup age to the
    // no-schedule week, so a six-day-stale nightly box answers
    // {protected, ok} on one click. The ClawKeep card says so in prose; the
    // agent reading this tool has only the verdict unless something ranks it,
    // and "you're protected" over a box nothing will back up again is the same
    // false success the rest of this tool exists to stop.
    //
    // Six days is chosen, not rounded: it brackets the only two windows the
    // verdict could be judged against — 36 h (DAY_MS + BACKUP_GRACE_MS, the
    // armed-daily window) < 6 d < 7 d (UNSCHEDULED_MAX_AGE_MS). Anything under
    // 36 h reads {protected, ok} whether or not expectedBackupWindowMs()
    // honours `enabled: false`, so it would prove nothing about the widening
    // this test is named for.
    //
    // The caveat rides on the RESULT, not the description: it is true of some
    // boxes and not others, and description text is paid for on every turn.
    apiGet.mockResolvedValue({
      paired: true,
      configured: true,
      supportedOnEdition: true,
      encryptionConfigured: true,
      lastBackupAtMs: Date.now() - 6 * 24 * 60 * 60 * 1000,
      lastHeartbeatStatus: "ok",
      schedule: { enabled: false, frequency: "daily" },
    });

    const out = await system("openclaw").call("backup_status", {});
    if (out.isError) throw new Error("backup_status failed");
    const body = JSON.parse(out.text);
    expect(body.protection).toEqual({ state: "protected", reason: "ok" });
    const notes = (body.notes as string[]).join("\n");
    expect(notes).toMatch(/No backup schedule is armed/);
    expect(notes).toMatch(/nothing is scheduled to make a newer one/i);
  });

  it("caveats a missing schedule the same as a disabled one", async () => {
    // expectedBackupWindowMs() widens to the no-schedule week on
    // `!schedule?.enabled` — false OR null OR absent — and the ClawKeep card
    // switches its copy on the same predicate. A note gated on `=== false`
    // would let a null schedule take the lenient window with no caveat, so the
    // two shapes that are not `false` are both walked here. Six days again,
    // for the reason spelled out above: under 36 h neither shape would prove
    // the widened window was the one taken.
    for (const [shape, schedule] of [["null", { schedule: null }], ["omitted", {}]] as const) {
      apiGet.mockResolvedValue({
        paired: true,
        configured: true,
        supportedOnEdition: true,
        encryptionConfigured: true,
        lastBackupAtMs: Date.now() - 6 * 24 * 60 * 60 * 1000,
        lastHeartbeatStatus: "ok",
        ...schedule,
      });

      const out = await system("openclaw").call("backup_status", {});
      if (out.isError) throw new Error("backup_status failed");
      const body = JSON.parse(out.text);
      expect(body.protection, `schedule ${shape}`).toEqual({ state: "protected", reason: "ok" });
      expect((body.notes as string[]).join("\n"), `schedule ${shape}`)
        .toMatch(/nothing is scheduled to make a newer one/i);
    }
  });

  it("never hands the agent lastHeartbeatStatus without saying it is not an outcome", async () => {
    // The exact live failure: backups died days ago, the daemon never wrote a
    // heartbeat about it, so the last one still reads "ok". Read literally the
    // agent tells the owner the last run succeeded.
    const staleBox = {
      paired: true,
      configured: true,
      supportedOnEdition: true,
      encryptionConfigured: true,
      lastBackupAtMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
      schedule: { enabled: true, frequency: "daily" },
    };
    apiGet.mockResolvedValue({ ...staleBox, lastHeartbeatStatus: "ok" });

    const out = await system("openclaw").call("backup_status", {});
    if (out.isError) throw new Error("backup_status failed");
    const body = JSON.parse(out.text);
    expect(body.protection.state).not.toBe("protected");
    const notes = (body.notes as string[]).join("\n");
    expect(notes).toMatch(/not the outcome by itself/i);
    expect(notes).toMatch(/Answer from protection/i);

    // The value itself is never interpolated into the note: it is already in
    // the body, and result text is screened by neither the description length
    // cap nor BANNED_DESCRIPTION_RE. "ok" cannot show that — the note quotes
    // the word as its own literal example ('can still read "ok"'), so an
    // absence check on it would read a coincidence as a passing contract. Ask
    // again with a value nothing but an interpolation could have put there.
    const sentinel = "zzz-heartbeat-sentinel-622";
    apiGet.mockResolvedValue({ ...staleBox, lastHeartbeatStatus: sentinel });
    const probe = await system("openclaw").call("backup_status", {});
    if (probe.isError) throw new Error("backup_status failed");
    const probeBody = JSON.parse(probe.text);
    // The fixture did arrive — otherwise the sentinel's absence from the notes
    // below would only be saying the mock never landed.
    expect(probeBody.lastHeartbeatStatus).toBe(sentinel);
    const probeNotes = (probeBody.notes as string[]).join("\n");
    expect(probeNotes).toMatch(/not the outcome by itself/i);
    expect(probeNotes).not.toContain(sentinel);
  });

  it("publishes no verdict for an unpaired box, the way the shelf shield does not", async () => {
    // unpairLocal() deliberately KEEPS the last successful stats, and
    // deriveProtection() judges lastBackupAtMs alone — it never sees `paired`.
    // So a box unpaired one minute ago still has a fresh lastBackupAtMs, and
    // deriving a verdict from it answered "you're protected" over a box that
    // can never back up again, while the shelf drew the calm setup shield.
    // `useClawkeepShieldStatus` publishes protection: null there; so does this.
    apiGet.mockResolvedValue({
      paired: false,
      configured: false,
      supportedOnEdition: true,
      encryptionConfigured: true,
      lastBackupAtMs: Date.now() - 60 * 1000,
      lastHeartbeatStatus: "ok",
      schedule: { enabled: true, frequency: "daily" },
    });

    const out = await system("openclaw").call("backup_status", {});
    if (out.isError) throw new Error("backup_status failed");
    const body = JSON.parse(out.text);
    expect(body.protection).toBeNull();
    const notes = (body.notes as string[]).join("\n");
    expect(notes).toMatch(/not paired/i);
    expect(notes).toMatch(/Settings -> Backup/);
    expect(notes).toMatch(/no tool here can pair it/i);
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

  it("reports a failed backup as a failure, from the status the route now answers", async () => {
    // Since TASK-672 a backup that RAN and failed is a real status carrying one
    // owner-facing sentence and a stable `code` — not a 200 with `ok:false` and
    // the daemon's raw log line in `stderrTail`, which is what the agent used
    // to relay to the owner, device paths and all.
    apiPost.mockRejectedValue(
      new ApiError(
        502,
        JSON.stringify({ error: "The backup did not finish", code: "backup_failed" }),
      ),
    );

    const out = await system("openclaw").call("backup_now", {});
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).toMatch(/did not finish|did not run/i);
    expect(out.error.next).toBeTruthy();
  });

  it("tells the owner to re-pair when the portal revoked this device mid-backup", async () => {
    // `EXIT_AUTH_REVOKED` (3) is the case no local check can see: the token
    // file is still on disk, so the pre-flight passes and the daemon only
    // learns of the revoke from the portal's 401. Retrying is pointless, so
    // the rule has to say so.
    apiPost.mockRejectedValue(
      new ApiError(
        401,
        JSON.stringify({
          error: "ClawKeep authorisation was rejected — pair this device again",
          code: "pairing_revoked",
        }),
      ),
    );

    const out = await system("openclaw").call("backup_now", {});
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/pairing/i);
    expect(out.error.next).toMatch(/pair the device again/i);
    expect(out.error.next).toMatch(/do not retry/i);
  });

  it("tells the owner the account is full rather than retrying into it", async () => {
    apiPost.mockRejectedValue(
      new ApiError(
        507,
        JSON.stringify({ error: "The ClawKeep account is out of space", code: "quota_full" }),
      ),
    );

    const out = await system("openclaw").call("backup_now", {});
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.message).toMatch(/out of space/i);
    expect(out.error.next).toMatch(/do not retry/i);
  });

  it("tells the agent to get the box paired when backup_now hits an unpaired one", async () => {
    // The route refuses an unpaired box with 409 `not_paired` before it spawns
    // the daemon, and BACKUP_RULES is what turns that into an instruction the
    // agent can act on. Without this the contract lives only in a comment: drop
    // `rules: BACKUP_RULES` from the apiPost call, or reorder the rules, and
    // the agent gets a bare 409 with no idea what to tell the user.
    apiPost.mockRejectedValue(
      new ApiError(
        409,
        JSON.stringify({ error: "ClawKeep is not paired with an account", code: "not_paired" }),
      ),
    );

    const out = await system("openclaw").call("backup_now", {});
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.message).toMatch(/not set up on this device/i);
    expect(out.error.next).toMatch(/Settings -> Backup/);
    expect(out.error.next).toMatch(/do not retry/i);
  });

  it("says the same thing for backup_list, which reaches the same 409", async () => {
    apiGet.mockRejectedValue(
      new ApiError(
        409,
        JSON.stringify({ error: "ClawKeep is not paired with an account", code: "not_paired" }),
      ),
    );

    const out = await system("openclaw").call("backup_list", {});
    expect(out.isError).toBe(true);
    if (!out.isError) return;
    expect(out.error.code).toBe("CONFLICT");
    expect(out.error.next).toMatch(/Settings -> Backup/);
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

    const built = await buildContext("hermes", "hermes", "full", "hermes");
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

    const built = await buildContext("hermes", "hermes", "full", "hermes");
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

  it("reads an install cli_failed as the device failing, not as a refusal that forbids retrying", async () => {
    // The install route answers 502 + cli_failed when the installer could not
    // be run. Without a branch it reached the 409/502 catch-all, which reports
    // "the device refused the install. Do not retry." — the wrong story, and
    // it forbids the one next step that can work.
    refuse(502, { error: "The device's Hermes command failed.", code: "cli_failed" });

    const e = await installErr();

    expect(e.code).toBe("INTERNAL");
    expect(e.next).toMatch(/retry once/i);
    expect(e.message).not.toMatch(/refused/i);
  });

  it("reads cli_missing as a device without Hermes — not a bad id, not a dead service", async () => {
    // HERMES-04: the install route's generic catch now names the CLI it could
    // not run. Before, a 502 with no code fell to the generic mapping and its
    // clawbox_health advice, for a device whose Hermes was simply not there.
    refuse(502, { error: "Hermes is not installed on this device", code: "cli_missing" });

    const e = await installErr();

    expect(e.code).toBe("NOT_SUPPORTED_HERE");
    expect(e.next).not.toMatch(/skill_search|clawbox_health|wifi_status/);
  });

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

  it("does not tell the agent nothing was installed when the skill is still there", async () => {
    // The SECOND state behind `incomplete_install`: the skill was already
    // installed before the request, so the rollback left the owner's copy in
    // place. The route says so and flags it; the decoder read neither, so the
    // agent was told "nothing was installed" about a skill that is on the
    // device, and sent to check the WiFi and retry — which cannot work, because
    // the installer meets the surviving lock entry and exits 0 without
    // fetching, landing back on the same missing files.
    refuse(502, {
      error:
        "Some of \"pdf-tools\"'s files are missing from the device. It was already installed "
        + "before this request, so it was left in place — remove it from the Skills store and "
        + "install it again.",
      code: "incomplete_install",
      preexisting: true,
      missingFiles: ["reference/pdf.md"],
    });

    const e = await installErr();

    expect(e.code).toBe("CONFLICT");
    expect(e.message).not.toMatch(/nothing was installed/i);
    expect(e.message).toMatch(/already installed|left in place/i);
    // The missing files are still worth relaying — they are what is wrong.
    expect(e.message).toMatch(/reference\/pdf\.md/);
    // The next step that CAN work, and not the one that cannot.
    expect(e.next).not.toMatch(/wifi_status/);
    expect(e.next).not.toMatch(/retry once/i);
    expect(e.next).toMatch(/do NOT retry/i);
    expect(e.next).toMatch(/skill_uninstall/);
  });

  it("refuses a short name the store cannot narrow down, without inventing an id", async () => {
    refuse(409, { error: "More than one skill goes by that name.", code: "ambiguous_id" });

    const e = await installErr("pdf");

    expect(e.code).toBe("BAD_ARGUMENT");
    expect(e.next).toMatch(/FULL id/);
  });

  it("reads the install route's 504 as a deadline, not as a dead service", async () => {
    // HERMES-04. The timeout answer is the one refusal outside the 409/502 the
    // decoder's catch-all is scoped to, so it fell through to the generic
    // mapping and told the agent to call clawbox_health for a slow download.
    refuse(504, {
      error: 'Installing "oo-terraform" took too long and was stopped, so nothing was installed.',
      code: "install_timeout",
    });

    const e = await installErr();

    expect(e.code).toBe("TIMEOUT");
    expect(e.message).toMatch(/nothing was installed/i);
    expect(e.next).toMatch(/retry once/i);
    expect(e.next).not.toMatch(/clawbox_health/);
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
// ── skill_search ─────────────────────────────────────────────────────────────

describe("skill_search — a slow catalogue is not a dead network", () => {
  function skills() {
    const h = captureRegistrar("hermes");
    registerSkillTools(h.reg);
    return h;
  }

  async function searchErr() {
    const out = await skills().call("skill_search", { query: "pdf", sort: "relevance", limit: 10 });
    if (!out.isError) throw new Error("expected skill_search to fail");
    return out.error;
  }

  it("reads the browse route's cli_timeout as a deadline to retry, not a network to check", async () => {
    // HERMES-04. The browse route used to answer a bare `{ error: "hermes timed
    // out" }`; every 502 was mapped to "call wifi_status" by status alone.
    apiGet.mockRejectedValue(
      new ApiError(
        502,
        JSON.stringify({ error: "Loading the skill catalogue took too long.", code: "cli_timeout" }),
      ),
    );

    const e = await searchErr();

    expect(e.code).toBe("TIMEOUT");
    expect(e.next).toMatch(/retry once/i);
    expect(e.next).not.toMatch(/wifi_status/);
  });

  it("refuses a search the route would reject without asking the device at all", async () => {
    // The tool guards on the same `isValidQuery` the browse route applies, so
    // a `bad_query` 400 cannot reach the rules — the request is never made.
    // (That is why no rule decodes it: an unreachable rule is the browse tab's
    // `browseCancelled` copy over again.)
    apiGet.mockRejectedValue(new ApiError(500, "{}"));

    const out = await skills().call("skill_search", { query: "-rf", sort: "relevance", limit: 10 });
    if (!out.isError) throw new Error("expected skill_search to fail");

    expect(out.error.code).toBe("BAD_ARGUMENT");
    expect(out.error.next).toMatch(/not starting with a dash/i);
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("reads cli_missing as a device without Hermes — not a network to check, not a retry", async () => {
    apiGet.mockRejectedValue(
      new ApiError(
        502,
        JSON.stringify({ error: "Hermes is not installed on this device, so the skill catalogue cannot be loaded.", code: "cli_missing" }),
      ),
    );

    const e = await searchErr();

    expect(e.code).toBe("NOT_SUPPORTED_HERE");
    expect(e.next).toMatch(/do not retry/i);
    expect(e.next).not.toMatch(/wifi_status/);
  });

  it("reads cli_failed as the device failing — one retry, no network check", async () => {
    apiGet.mockRejectedValue(
      new ApiError(502, JSON.stringify({ error: "The device could not load the skill catalogue.", code: "cli_failed" })),
    );

    const e = await searchErr();

    expect(e.code).toBe("INTERNAL");
    expect(e.next).toMatch(/retry once/i);
    expect(e.next).not.toMatch(/wifi_status/);
  });

  it("reads too_large as a narrower search, not a dead service", async () => {
    apiGet.mockRejectedValue(
      new ApiError(502, JSON.stringify({ error: "The device's answer was too large to use.", code: "too_large" })),
    );

    const e = await searchErr();

    expect(e.code).toBe("TOO_LARGE");
    expect(e.next).not.toMatch(/wifi_status/);
  });

  it("still sends a code-less 502 to the network check", async () => {
    // The guard for older device builds and the other failure codes: nothing
    // narrower than a timeout has earned different advice.
    apiGet.mockRejectedValue(new ApiError(502, JSON.stringify({ error: "Browse failed" })));

    const e = await searchErr();

    expect(e.code).toBe("ENDPOINT_DOWN");
    expect(e.next).toMatch(/wifi_status/);
  });
});

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

    expect(ai.device_default).toEqual({ provider: "unknown", model: "unknown", thinking: "unknown" });
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

    expect(ai.device_default).toEqual({ provider: "clawlocal", model: "llama3.2:3b", thinking: "minimal" });
  });

  it("applies the same guard to the OpenClaw branch, which reads the same shape", async () => {
    routes({ "/setup-api/chat/model": { selected: { provider: "", model: "" }, current: "" } });

    const { ai } = await body("openclaw");

    expect(ai.device_default).toMatchObject({ provider: "unknown", model: "unknown" });
  });
});
