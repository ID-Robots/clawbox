import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("clawbox MCP browser guidance", () => {
  it("tells agents to use browser_open for real Chromium browsing", () => {
    const mcpSource = fs.readFileSync(
      path.join(process.cwd(), "mcp", "clawbox-mcp.ts"),
      "utf8",
    );

    expect(mcpSource).toContain("Use the dedicated browser_* tools for web browsing and browser automation.");
    expect(mcpSource).toContain('server.tool("browser_open"');
    expect(mcpSource).toContain('Do not use ui_open_app("browser") for normal browsing.');
  });

  it("marks the desktop browser app as setup instead of the browsing target", () => {
    const mcpSource = fs.readFileSync(
      path.join(process.cwd(), "mcp", "clawbox-mcp.ts"),
      "utf8",
    );

    expect(mcpSource).toContain('name: "Browser Setup"');
    expect(mcpSource).toContain("Browser integration settings panel, not the real browsing window");
    expect(mcpSource).toContain("Opening Browser Setup. This app configures browser integration.");
  });
});
