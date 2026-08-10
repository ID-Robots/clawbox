import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Agents kept reaching for `ui_open_app("browser")` when asked to browse the
 * web, which opens the integration *settings* panel and browses nothing. These
 * tests guard the guidance that steers them to the real Chromium tools.
 *
 * They scan the whole `mcp/` tree rather than a single file — the server has
 * been split into `lib/` and `tools/` once already, and an assertion pinned to
 * one path fails on refactors that changed nothing an agent can observe. For
 * the same reason they match on shape, not on exact prose.
 */
const MCP_DIR = path.join(process.cwd(), "mcp");

function mcpSources(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(MCP_DIR);
  return out.join("\n");
}

describe("clawbox MCP browser guidance", () => {
  const source = mcpSources();

  it("registers the real-Chromium browsing tools", () => {
    expect(source).toContain('"browser_open"');
    expect(source).toContain('"browser_navigate"');
  });

  it("tells agents to browse with browser_open rather than the desktop app", () => {
    // Somewhere in the server's prose: browser_open named as the way to browse.
    expect(source).toMatch(/(?:web|browse|browsing)[^\n]*browser_open/i);
    // And an explicit steer away from opening the "browser" app to browse.
    expect(source).toMatch(/(?:not|instead of|do not)[^\n]*"browser" (?:desktop )?app/i);
  });

  it("labels the desktop browser app as a settings panel, not the browsing window", () => {
    expect(source).toContain('name: "Browser Setup"');
    expect(source).toMatch(/integration (?:settings )?panel, not the (?:real )?browsing window/i);
  });
});
