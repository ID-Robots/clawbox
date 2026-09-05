import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * TASK-540 — `clawbox_context` served `Clawbox.md` verbatim, so the Hermes
 * agent was oriented by an OpenClaw script.
 *
 * Every orienting claim it got wrong was load-bearing: it was told it is "the
 * brain of an OpenClaw ClawBox", handed the address of a gateway that is
 * removed and masked on that SKU and the path of a config file that does not
 * exist there, and offered `bash`, `write_file`, `glob`, `grep`, `web_search`
 * and the rest of the coding family — none of which `mcp/tools/coding.ts`
 * registers on Hermes. `mcp/clawbox-mcp.ts` `instructionsFor()` had already
 * branched the server's own stub per edition for exactly this reason; the field
 * guide was the half that had not.
 *
 * The guard below is deliberately computed rather than listed: the tool sets
 * come from the real registrars, so a tool that changes edition takes the
 * assertion with it.
 */

// `DEFAULT_CWD` is read at import time by mcp/lib/guard.ts, and the field guide
// path is built from it — so the repo root has to be in the environment before
// the module graph loads.
const REPO_ROOT = vi.hoisted(() => {
  const root = process.cwd();
  process.env.CLAWBOX_ROOT = root;
  return root;
});

vi.mock("../../../mcp/lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiTry: vi.fn().mockResolvedValue(null),
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

import type { McpContext } from "../../../mcp/lib/context";
import { captureRegistrar } from "../helpers/mcp-registrar";
import { fieldGuideForEdition, registerOrientationTools } from "../../../mcp/tools/orientation";
import { registerSystemTools } from "../../../mcp/tools/system";
import { registerDesktopTools } from "../../../mcp/tools/desktop";
import { registerSkillTools } from "../../../mcp/tools/skills";
import { registerAiTools } from "../../../mcp/tools/ai";
import { registerBrowserTools } from "../../../mcp/tools/browser";
import { registerMediaTools } from "../../../mcp/tools/media";
import { registerEmailTools } from "../../../mcp/tools/email";
import { registerCodingTools } from "../../../mcp/tools/coding";
import { registerCodingAgentTools, registerCodingTeamTools } from "../../../mcp/tools/coding-agent";

type Ed = "openclaw" | "hermes";

const GUIDE = readFileSync(path.join(REPO_ROOT, "Clawbox.md"), "utf-8");
const served = (edition: Ed) => fieldGuideForEdition(GUIDE, edition);

/** The shipped posture: every capability probe satisfied, every owner switch on. */
const ctx = (edition: Ed): McpContext => ({
  edition,
  install: edition,
  appHarness: edition,
  profile: "full",
  capabilities: { screenGrabber: "gnome-screenshot", imageConvert: true, journal: true, du: true },
  providers: ["clawai"],
  emailCanRead: true,
  codingAgent: true,
  canGenerateImages: true,
});

/** Every tool name the real MCP server registers on this edition. */
function toolNames(edition: Ed): Set<string> {
  const h = captureRegistrar(edition);
  const c = ctx(edition);
  registerOrientationTools(h.reg, c);
  registerSkillTools(h.reg);
  registerAiTools(h.reg, c);
  registerSystemTools(h.reg, c);
  registerDesktopTools(h.reg, c);
  registerBrowserTools(h.reg);
  registerMediaTools(h.reg);
  registerEmailTools(h.reg, c);
  registerCodingTools(h.reg);
  registerCodingAgentTools(h.reg, c);
  registerCodingTeamTools(h.reg, c);
  return new Set(h.names());
}

const onlyOn = (a: Ed, b: Ed): string[] => {
  const other = toolNames(b);
  return [...toolNames(a)].filter((n) => !other.has(n)).sort();
};

/** `name(` or `name)` or bare — anywhere it is offered as a symbol to call. */
const offers = (text: string, tool: string) =>
  new RegExp("`" + tool + "\\b[^`]*`").test(text);

describe("the field guide is fenced, and both fences are well formed", () => {
  it("balances every edition block", () => {
    const opens = GUIDE.split("\n").filter((l) => /^<!--\s*edition:[a-z]+\s*-->\s*$/.test(l));
    const closes = GUIDE.split("\n").filter((l) => /^<!--\s*\/edition\s*-->\s*$/.test(l));
    expect(opens.length).toBeGreaterThan(0);
    expect(closes.length).toBe(opens.length);
  });

  it("names no edition the filter cannot serve", () => {
    const names = [...GUIDE.matchAll(/^<!--\s*edition:([a-z]+)\s*-->\s*$/gm)].map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual(["hermes", "openclaw"]);
  });

  it("leaves no fence marker in what the agent reads", () => {
    for (const edition of ["openclaw", "hermes"] as const) {
      expect(served(edition)).not.toMatch(/<!--\s*\/?edition/);
    }
  });

  it("stays inside the tool's own output cap on both editions", () => {
    // clawbox_context declares maxChars 24_000 and appends the webapp storage
    // guide after this text; a guide that outgrew the cap would be truncated
    // mid-sentence, and the truncation would land on the LAST section.
    for (const edition of ["openclaw", "hermes"] as const) {
      expect(served(edition).length).toBeLessThan(20_000);
    }
  });
});

describe("the Hermes guide describes a Hermes box", () => {
  it("does not call the agent the brain of an OpenClaw ClawBox", () => {
    expect(served("hermes")).not.toMatch(/brain of an \*\*OpenClaw ClawBox\*\*/);
    expect(served("hermes")).toMatch(/brain of a \*\*Hermes ClawBox\*\*/);
  });

  it("does not hand out the address of a gateway this SKU masks", () => {
    expect(served("hermes")).not.toContain("http://127.0.0.1:18789");
    expect(served("hermes")).not.toContain("Proxied to OpenClaw gateway");
    expect(served("hermes")).not.toMatch(/:18789\s+OpenClaw gateway \(you live here/);
  });

  it("does not name a config file that does not exist there", () => {
    expect(served("hermes")).not.toContain("~/.openclaw/openclaw.json");
    expect(served("hermes")).toContain("~/.hermes/config.yaml");
  });

  it("offers no tool the MCP server does not register on Hermes", () => {
    const openclawOnly = onlyOn("openclaw", "hermes");
    // Guards the guard: if this ever empties, the assertion below is vacuous.
    expect(openclawOnly).toContain("bash");
    expect(openclawOnly).toContain("write_file");
    expect(openclawOnly).toContain("web_search");

    const leaked = openclawOnly.filter((tool) => offers(served("hermes"), tool));
    expect(leaked).toEqual([]);
  });

  it("names the abilities that ARE its own", () => {
    const guide = served("hermes");
    for (const tool of ["skill_search", "skill_install", "ai_list_models"]) {
      expect(offers(guide, tool)).toBe(true);
    }
  });
});

describe("the OpenClaw guide keeps everything it had", () => {
  it("still says what the box is and where the gateway lives", () => {
    const guide = served("openclaw");
    expect(guide).toMatch(/brain of an \*\*OpenClaw ClawBox\*\*/);
    expect(guide).toContain("http://127.0.0.1:18789");
    expect(guide).toContain("~/.openclaw/openclaw.json");
    expect(guide).toContain("App Store");
  });

  it("still offers the whole coding family", () => {
    const guide = served("openclaw");
    for (const tool of ["bash", "read_file", "write_file", "edit_file", "glob", "grep", "web_search", "web_fetch", "notebook_edit"]) {
      expect(offers(guide, tool)).toBe(true);
    }
  });

  it("is not handed a tool that exists only on Hermes", () => {
    const leaked = onlyOn("hermes", "openclaw").filter((tool) => offers(served("openclaw"), tool));
    expect(leaked).toEqual([]);
  });
});

describe("what is true on both editions is served to both", () => {
  for (const edition of ["openclaw", "hermes"] as const) {
    it(`keeps the shared guide on ${edition}`, () => {
      const guide = served(edition);
      expect(guide).toContain('preferences_set(\'{"ui_user_name": "<name>"}\')');
      expect(guide).toContain("THE MASCOT");
      for (const tool of ["webapp_create", "ui_open_app", "code_project_init", "system_power", "wifi_status"]) {
        expect(offers(guide, tool)).toBe(true);
      }
    });
  }
});

describe("clawbox_context serves the filtered guide, not the raw file", () => {
  async function contextText(edition: Ed) {
    const h = captureRegistrar(edition);
    registerOrientationTools(h.reg, ctx(edition));
    const out = await h.call("clawbox_context", {});
    if (out.isError) throw new Error("clawbox_context failed");
    return out.text;
  }

  it("gives a Hermes agent the Hermes guide", async () => {
    const text = await contextText("hermes");
    expect(text).toMatch(/brain of a \*\*Hermes ClawBox\*\*/);
    expect(text).not.toContain("http://127.0.0.1:18789");
    expect(text).not.toContain("~/.openclaw/openclaw.json");
  });

  it("gives an OpenClaw agent the OpenClaw guide", async () => {
    const text = await contextText("openclaw");
    expect(text).toMatch(/brain of an \*\*OpenClaw ClawBox\*\*/);
    expect(text).toContain("http://127.0.0.1:18789");
  });
});
