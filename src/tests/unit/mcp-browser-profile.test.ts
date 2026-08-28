/**
 * The `browser` MCP profile — what a delegated coding-agent run is allowed to
 * see. The runner starts the clawbox server with CLAWBOX_MCP_PROFILE=browser,
 * and the whole containment story rests on the registrar dropping everything
 * that is not browser_*: a run must drive Chromium, never send email or flip
 * device switches through the assistant's wider tool set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";
import { createRegistrar, type Profile } from "../../../mcp/lib/register";
import { registerBrowserTools } from "../../../mcp/tools/browser";
import { profileForActiveModel } from "../../../mcp/lib/profile";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function stubServer(): McpServer {
  return {
    registerTool: vi.fn(),
    server: { setRequestHandler: vi.fn() },
  } as unknown as McpServer;
}

function names(profile: Profile, edition: "openclaw" | "hermes" = "openclaw"): string[] {
  const reg = createRegistrar(stubServer(), edition, profile);
  registerBrowserTools(reg);
  // A non-browser tool riding along must be dropped by the profile — and so
  // must a tool that merely NAMED itself browser_* without declaring the
  // family: the gate is the declaration, never the christening.
  reg.tool("email_send", "x", {}, { editions: ["openclaw", "hermes"] }, async () => ({ content: [] }));
  reg.tool("browser_impostor", "x", {}, { editions: ["openclaw", "hermes"] }, async () => ({ content: [] }));
  // ...and the converse: a tool that DECLARED the family under a name with no
  // browser_ prefix belongs to the run. Without it, "everything registered
  // starts with browser_" would hold just as well for a registrar that gated
  // on the name.
  reg.tool("family_member", "x", {}, { editions: ["openclaw", "hermes"], family: "browser" }, async () => ({ content: [] }));
  return reg.list().map((t) => t.name);
}

let restore: () => void;

beforeEach(() => {
  restore = saveEnv("CLAWBOX_RUN_DIR", "CLAWBOX_RUN_ARTIFACTS_DIR", "CLAWBOX_MCP_PROFILE");
  delete process.env.CLAWBOX_RUN_DIR;
  delete process.env.CLAWBOX_RUN_ARTIFACTS_DIR;
});

afterEach(() => restore());

describe("the browser profile", () => {
  it("registers only the browser family, and keeps every family on full", () => {
    const browser = names("browser");
    expect(browser).toContain("browser_open");
    expect(browser).toContain("browser_screenshot");
    // The declaration decides, in both directions.
    expect(browser).not.toContain("email_send");
    expect(browser).not.toContain("browser_impostor");
    expect(browser).toContain("family_member");
    // And every real browser_* tool declares it — the ride-along is the only
    // name in the profile that is not one.
    expect(browser.filter((n) => n !== "family_member").every((n) => n.startsWith("browser_"))).toBe(true);
    const full = names("full");
    for (const name of ["email_send", "browser_impostor", "family_member", "browser_open"]) expect(full).toContain(name);
  });

  it("offers browser_view_local only inside a run — and only when the runner named BOTH folders", () => {
    expect(names("browser")).not.toContain("browser_view_local");
    // One stray variable is not a run context: all-or-nothing, so a
    // half-configured environment cannot produce chimera behavior.
    process.env.CLAWBOX_RUN_DIR = "/home/clawbox/clawbox/data/code-projects/site";
    expect(names("browser")).not.toContain("browser_view_local");
    process.env.CLAWBOX_RUN_ARTIFACTS_DIR = "/home/clawbox/clawbox/data/coding-agent-artifacts/run-abc12345";
    expect(names("browser")).toContain("browser_view_local");
  });

  it("is selectable through CLAWBOX_MCP_PROFILE", () => {
    process.env.CLAWBOX_MCP_PROFILE = "browser";
    expect(profileForActiveModel(null)).toBe("browser");
  });
});
