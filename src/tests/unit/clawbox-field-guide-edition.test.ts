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
import { WEBAPP_STORAGE_GUIDE, fieldGuideForEdition, registerOrientationTools } from "../../../mcp/tools/orientation";
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
type Install = "openclaw" | "hermes" | "dual";

const GUIDE = readFileSync(path.join(REPO_ROOT, "Clawbox.md"), "utf-8");
const served = (edition: Ed, install: Install = edition) => fieldGuideForEdition(GUIDE, edition, install);

/** The shipped posture: every capability probe satisfied, every owner switch on. */
const ctx = (edition: Ed, install: Install = edition): McpContext => ({
  edition,
  install,
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

/** Every (harness, install) a real box can present. */
const BOXES: [Ed, Install][] = [
  ["openclaw", "openclaw"],
  ["hermes", "hermes"],
  ["openclaw", "dual"],
  ["hermes", "dual"],
];

describe("the field guide is fenced, and the fences are well formed", () => {
  it("nests every block properly — no unmatched close, nothing left open", () => {
    // Equal counts are NOT the property: a block opened inside another block's
    // body, then closed, used to end BOTH — and the remainder of the outer
    // block was served to every box with the counts still balanced.
    const stack: string[] = [];
    let opens = 0;
    GUIDE.split("\n").forEach((line, i) => {
      const open = /^<!--\s*(edition|ships):([a-z0-9_-]+)\s*-->\s*$/.exec(line);
      if (open) {
        opens += 1;
        stack.push(open[1]);
        return;
      }
      const close = /^<!--\s*\/(edition|ships)\s*-->\s*$/.exec(line);
      if (!close) return;
      expect(stack.pop(), `line ${i + 1}: close with no open`).toBe(close[1]);
    });
    expect(opens).toBeGreaterThan(0);
    expect(stack, "a block was left open").toEqual([]);
  });

  it("names no audience the filter cannot serve", () => {
    const names = [...GUIDE.matchAll(/^<!--\s*(edition|ships):([a-z0-9_-]+)\s*-->\s*$/gm)].map((m) => `${m[1]}:${m[2]}`);
    expect([...new Set(names)].sort()).toEqual([
      "edition:hermes",
      "edition:openclaw",
      "ships:hermes",
      "ships:openclaw",
    ]);
  });

  it("leaves no fence marker in what the agent reads", () => {
    for (const [edition, install] of BOXES) {
      expect(served(edition, install)).not.toMatch(/<!--\s*\/?(edition|ships)/);
    }
  });

  it("stays inside the tool's own output cap on every box", () => {
    // The real budget: clawbox_context declares maxChars 24_000 and joins this
    // text with WEBAPP_STORAGE_GUIDE and a "\n\n---\n\n" separator. capText
    // truncates the TAIL, so an overrun eats Quick facts and the final brief.
    const separator = "\n\n---\n\n".length;
    for (const [edition, install] of BOXES) {
      expect(served(edition, install).length + separator + WEBAPP_STORAGE_GUIDE.length).toBeLessThan(24_000);
    }
  });
});

describe("the Hermes guide describes a Hermes box", () => {
  it("does not call the agent the brain of an OpenClaw ClawBox", () => {
    expect(served("hermes")).not.toMatch(/brain of an \*\*OpenClaw ClawBox\*\*/);
    expect(served("hermes")).toMatch(/brain of a \*\*Hermes ClawBox\*\*/);
  });

  /**
   * The quoted block under "First-contact" — the one the agent is told to say
   * on a fresh box, and the only part of this document meant to be spoken
   * almost verbatim.
   */
  const introScript = (edition: Ed, install: Install = edition): string => {
    const guide = served(edition, install);
    const start = guide.search(/^## First-contact/m);
    expect(start, "the first-contact section moved").toBeGreaterThan(-1);
    return guide
      .slice(start)
      .split("\n")
      .filter((line) => line.startsWith("> "))
      .join("\n");
  };

  it("names no capability-gated tool in the script it is told to say verbatim", () => {
    // `logs_tail` and `disk_usage`/`disk_cleanup` are registered only when the
    // startup probe passes; `coding_agent_*` and `email_*` only when the owner
    // switched them on. The toolbelt above may list them with their caveat —
    // the introduction may not, because it is read out as a promise.
    const script = introScript("hermes");
    // Guards the guard: an empty slice would pass every assertion below.
    expect(script.length).toBeGreaterThan(200);
    for (const gated of [/service logs/i, /coding agent/i, /\bemail\b/i, /\bdisk\b/i]) {
      expect(script, `intro promises ${gated}`).not.toMatch(gated);
    }
  });

  it("promises none of the missing abilities in the introduction script either", () => {
    // The one block designed to be spoken verbatim on a fresh box. It named
    // shell, files, the app store and web search in ENGLISH, which the symbol
    // check below cannot see — so the defect this card is about survived in
    // the sales pitch after it was removed from the identity paragraph.
    const guide = served("hermes");
    for (const promise of [/run shell commands/i, /manage files/i, /install apps from the store/i, /web search/i, /web fetch/i]) {
      expect(guide, `Hermes guide promises ${promise}`).not.toMatch(promise);
    }
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

    for (const install of ["hermes", "dual"] as const) {
      const leaked = openclawOnly.filter((tool) => offers(served("hermes", install), tool));
      expect(leaked, `install=${install}`).toEqual([]);
    }
  });

  it("names the abilities that ARE its own", () => {
    const guide = served("hermes");
    for (const tool of ["skill_search", "skill_install", "ai_list_models"]) {
      expect(offers(guide, tool)).toBe(true);
    }
  });

  it("sends the agent to a Settings tab that exists", () => {
    // SettingsApp's `ai` section is labelled settings.providers -> "Providers".
    // There is no tab called "AI"; the sibling workspace guide already has a
    // test forbidding that exact wrong turn.
    for (const [edition, install] of BOXES) {
      expect(served(edition, install)).not.toMatch(/Settings\s*(->|→)\s*AI\b/);
    }
  });
});

describe("the DUAL SKU is told what it has, not what the active harness has", () => {
  it("still names the gateway on a dual box running Hermes", () => {
    // The gateway removal, the mask and the closed 18789 are gated on
    // CLAWBOX_EDITION = "hermes" EXACTLY (install.sh is_hermes_edition). On
    // dual the unit is installed and listening, so a guide that told the agent
    // it was gone would be stating a false device fact about the box's own
    // unauthenticated control surface.
    const guide = served("hermes", "dual");
    expect(guide).toContain("http://127.0.0.1:18789");
    expect(guide).toContain("~/.openclaw/openclaw.json");
  });

  it("names the Hermes dashboard on a dual box running OpenClaw", () => {
    const guide = served("openclaw", "dual");
    expect(guide).toContain("~/.hermes/config.yaml");
    expect(guide).toContain("127.0.0.2:9119");
  });

  it("never asserts the other harness is absent", () => {
    // A locked SKU may say what it does not have; `dual` has both, and the
    // filter cannot tell the two apart from `ctx.edition` alone.
    for (const [edition, install] of BOXES) {
      expect(served(edition, install)).not.toMatch(/no OpenClaw (gateway )?(at all|on this device)/i);
      expect(served(edition, install)).not.toMatch(/there is no `~\/\.openclaw`/i);
    }
  });

  it("keeps a Hermes box from being handed the gateway", () => {
    const guide = served("hermes", "hermes");
    expect(guide).not.toContain("http://127.0.0.1:18789");
    expect(guide).not.toContain("~/.openclaw/openclaw.json");
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
  for (const [edition, install] of BOXES) {
    it(`keeps the shared guide on ${edition} (install ${install})`, () => {
      const guide = served(edition, install);
      expect(guide).toContain('preferences_set(\'{"ui_user_name": "<name>"}\')');
      expect(guide).toContain("THE MASCOT");
      for (const tool of ["webapp_create", "ui_open_app", "code_project_init", "system_power", "wifi_status"]) {
        expect(offers(guide, tool)).toBe(true);
      }
    });
  }
});

describe("clawbox_context serves the filtered guide, not the raw file", () => {
  async function contextText(edition: Ed, install: Install = edition) {
    const h = captureRegistrar(edition);
    registerOrientationTools(h.reg, ctx(edition, install));
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

  it("passes the install through, so a dual box keeps both harnesses' facts", async () => {
    const text = await contextText("hermes", "dual");
    expect(text).toMatch(/brain of a \*\*Hermes ClawBox\*\*/);
    expect(text).toContain("http://127.0.0.1:18789");
  });
});

describe("the filter's nesting rule", () => {
  const NESTED = [
    "shared top",
    "<!-- edition:openclaw -->",
    "openclaw before",
    "<!-- edition:hermes -->",
    "hermes inside",
    "<!-- /edition -->",
    "openclaw after",
    "<!-- /edition -->",
    "shared tail",
  ].join("\n");

  it("keeps an inner block inside its outer one", () => {
    // The bug this replaces: a close reset the state to "outside", so
    // "openclaw after" was served to every box with the marker counts still
    // balanced — the shape every well-formedness test above would pass over.
    expect(fieldGuideForEdition(NESTED, "hermes").split("\n")).toEqual(["shared top", "shared tail"]);
    expect(fieldGuideForEdition(NESTED, "openclaw").split("\n")).toEqual([
      "shared top",
      "openclaw before",
      "openclaw after",
      "shared tail",
    ]);
  });

  it("drops a block whose audience it cannot place", () => {
    const unknown = ["a", "<!-- edition:hermes2 -->", "b", "<!-- /edition -->", "c"].join("\n");
    expect(fieldGuideForEdition(unknown, "hermes").split("\n")).toEqual(["a", "c"]);
  });
});
