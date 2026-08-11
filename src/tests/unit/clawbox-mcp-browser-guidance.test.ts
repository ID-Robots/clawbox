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

  /**
   * The desktop app was not the only wrong door. The HARNESS ships its own
   * browser tool, and an agent asked to "open the browser on the docs page"
   * reached for that one — which on this device drives a browser the user
   * cannot see, and whose engine is not installed. Measured: 145-182s per turn,
   * ending in "install --with-deps" advice, with the working tools alongside.
   */
  it("steers agents off the harness's own built-in browser tool", () => {
    expect(source).toMatch(/built-in browser tool[^\n]*harness|harness[^\n]*built-in browser tool/i);
  });
});

/**
 * Steering is advisory — a model under pressure will still try a tool it
 * remembers. Provisioning therefore retires the built-in toolset outright.
 */
describe("Hermes provisioning retires the built-in browser toolset", () => {
  const script = fs.readFileSync(
    path.join(process.cwd(), "scripts", "register-mcp.sh"),
    "utf8",
  );

  /**
   * These assert PROPERTIES of the command, not its exact shell text. An
   * earlier version pinned the redirection order and `; then` placement, which
   * breaks on a harmless reformat while still passing for a real regression.
   *
   * The script explains itself in prose that mentions the same identifiers, so
   * every check below looks at the executable line — comments excluded.
   */
  const commandLines = script
    .split("\n")
    .filter(line => !/^\s*#/.test(line));

  /**
   * The line that actually runs the disable, not one of the ones about it.
   * Requires the hermes binary too — matching the bare subcommand would accept
   * an `if echo "tools disable browser"` that never invokes the harness.
   */
  const disableLine = commandLines.find(
    line => /"\$HERMES_BIN"\s+tools\s+disable\s+browser\b/.test(line),
  ) ?? "";

  it("disables the toolset through the supported CLI", () => {
    expect(disableLine).not.toBe("");
    // NOT by hand-writing a config key: verified on-device that the state does
    // not live under agent.disabled_toolsets, so a config write would be a guess.
    expect(commandLines.join("\n")).not.toMatch(/config\s+set[^\n]*disabled_toolsets/);
  });

  it("reconciles every boot rather than once behind a marker", () => {
    // A marker in ClawBox's data/ cannot see Hermes' own store, so anything
    // that reset ~/.hermes would leave it set and the toolset on, permanently.
    expect(commandLines.join("\n")).not.toMatch(/^\s*[A-Za-z_]*MARKER[A-Za-z_]*=/m);
    // ...and the call is not gated on a file existing.
    expect(disableLine).not.toMatch(/-f\b/);
  });

  it("cannot abort the boot when the harness refuses", () => {
    // register-mcp.sh runs under `set -euo pipefail` from production-server.js
    // at every web-server boot, so an unguarded non-zero exit would stop it.
    // Being the `if` condition is what makes the failure non-fatal.
    expect(disableLine).toMatch(/^\s*if\b/);
  });
});
