#!/usr/bin/env bun
/**
 * ClawBox MCP Server
 *
 * Exposes ClawBox device capabilities as MCP tools for AI agents.
 * Communicates via stdio transport, makes HTTP requests to the local
 * ClawBox web server and runs shell commands directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";

const API_BASE = process.env.CLAWBOX_API_BASE || "http://127.0.0.1:80";
const COMMAND_TIMEOUT = 30_000;
const UI_PICKUP_DELAY_MS = 2500;

// ── Helpers ──

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

async function apiPost(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Spawns an unrestricted shell — intended only for authorized MCP agents on a
// trusted local network. COMMAND_TIMEOUT and explicit cwd/HOME mitigate runaways.
async function runShell(command: string, timeoutMs = COMMAND_TIMEOUT): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      timeout: timeoutMs,
      cwd: "/home/clawbox",
      env: { ...process.env, HOME: "/home/clawbox" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
  });
}

// ── MCP Server ──

const server = new McpServer({
  name: "clawbox",
  version: "1.0.0",
});

// ── System Tools ──

server.tool(
  "system_stats",
  "Get comprehensive system statistics including CPU, memory, disk, network, temperature, GPU usage, and top processes",
  async () => {
    const stats = await api("/setup-api/system/stats");
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  }
);

server.tool(
  "system_info",
  "Get basic system information: hostname, CPU, memory, temperature, disk usage",
  async () => {
    const info = await api("/setup-api/system/info");
    return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
  }
);

server.tool(
  "system_power",
  "Restart or shut down the ClawBox device",
  { action: z.enum(["restart", "shutdown"]).describe("Power action to perform") },
  async ({ action }) => {
    await apiPost("/setup-api/system/power", { action });
    return { content: [{ type: "text", text: `Power action '${action}' initiated.` }] };
  }
);

// ── Shell / Terminal ──

server.tool(
  "run_command",
  "Execute a shell command on the ClawBox device and return stdout/stderr. Use for system tasks, package management, file operations, git commands, etc.",
  {
    command: z.string().describe("Shell command to execute"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default 30000)"),
  },
  async ({ command, timeout }) => {
    const result = await runShell(command, timeout ?? COMMAND_TIMEOUT);
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
    parts.push(`[exit code: ${result.exitCode}]`);
    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ── File Operations ──

server.tool(
  "file_list",
  "List files and directories in a given path on the ClawBox device",
  {
    directory: z.string().optional().describe("Relative path from home directory (default: home root)"),
  },
  async ({ directory }) => {
    const dir = directory || "";
    const data = await api(`/setup-api/files?dir=${encodeURIComponent(dir)}`);
    return { content: [{ type: "text", text: JSON.stringify(data.files, null, 2) }] };
  }
);

server.tool(
  "file_read",
  "Read the contents of a file on the ClawBox device",
  {
    path: z.string().describe("Relative path from home directory to the file"),
  },
  async ({ path }) => {
    const res = await fetch(`${API_BASE}/setup-api/files/${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`Failed to read file: ${res.status}`);
    const text = await res.text();
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "file_write",
  "Write content to a file on the ClawBox device",
  {
    path: z.string().describe("Relative path from home directory"),
    content: z.string().describe("File content to write"),
  },
  async ({ path, content }) => {
    const res = await fetch(`${API_BASE}/setup-api/files/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: content,
    });
    if (!res.ok) throw new Error(`Failed to write file: ${res.status}`);
    return { content: [{ type: "text", text: `File written: ${path}` }] };
  }
);

server.tool(
  "file_mkdir",
  "Create a directory on the ClawBox device",
  {
    directory: z.string().describe("Parent directory (relative from home)"),
    name: z.string().describe("Name of the new directory"),
  },
  async ({ directory, name }) => {
    await apiPost(`/setup-api/files?dir=${encodeURIComponent(directory)}`, {
      action: "mkdir",
      name,
    });
    return { content: [{ type: "text", text: `Directory created: ${directory}/${name}` }] };
  }
);

// ── Browser Automation ──

server.tool(
  "browser_launch",
  "Launch a headless Chromium browser session and optionally navigate to a URL. Returns a base64 screenshot.",
  {
    url: z.string().optional().describe("URL to navigate to after launch"),
  },
  async ({ url }) => {
    const result = await apiPost("/setup-api/browser", {
      action: "launch",
      ...(url ? { url } : {}),
    });
    const parts: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [];
    parts.push({ type: "text", text: `Browser launched. Session active.${url ? ` Navigated to: ${url}` : ""}` });
    if (result.screenshot) {
      parts.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
    }
    return { content: parts };
  }
);

server.tool(
  "browser_navigate",
  "Navigate the browser to a URL and return a screenshot",
  {
    url: z.string().describe("URL to navigate to"),
  },
  async ({ url }) => {
    const result = await apiPost("/setup-api/browser", { action: "navigate", url });
    const parts: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [];
    parts.push({ type: "text", text: `Navigated to: ${url}` });
    if (result.screenshot) {
      parts.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
    }
    return { content: parts };
  }
);

server.tool(
  "browser_click",
  "Click at specific coordinates in the browser window",
  {
    x: z.number().describe("X coordinate to click"),
    y: z.number().describe("Y coordinate to click"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default: left)"),
  },
  async ({ x, y, button }) => {
    const result = await apiPost("/setup-api/browser", {
      action: "click",
      x, y,
      ...(button ? { button } : {}),
    });
    const parts: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [];
    parts.push({ type: "text", text: `Clicked at (${x}, ${y})` });
    if (result.screenshot) {
      parts.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
    }
    return { content: parts };
  }
);

server.tool(
  "browser_type",
  "Type text into the browser (into the currently focused element)",
  {
    text: z.string().describe("Text to type"),
  },
  async ({ text }) => {
    const result = await apiPost("/setup-api/browser", { action: "type", text });
    const parts: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [];
    parts.push({ type: "text", text: `Typed: "${text}"` });
    if (result.screenshot) {
      parts.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
    }
    return { content: parts };
  }
);

server.tool(
  "browser_keypress",
  "Press a keyboard key in the browser (Enter, Tab, Escape, Backspace, etc.)",
  {
    key: z.string().describe("Key name to press (e.g. Enter, Tab, Escape, ArrowDown)"),
  },
  async ({ key }) => {
    const result = await apiPost("/setup-api/browser", { action: "keydown", key });
    const parts: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [];
    parts.push({ type: "text", text: `Pressed key: ${key}` });
    if (result.screenshot) {
      parts.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
    }
    return { content: parts };
  }
);

server.tool(
  "browser_scroll",
  "Scroll the browser page",
  {
    x: z.number().describe("X coordinate to scroll at"),
    y: z.number().describe("Y coordinate to scroll at"),
    deltaX: z.number().optional().describe("Horizontal scroll amount"),
    deltaY: z.number().describe("Vertical scroll amount (positive = down)"),
  },
  async ({ x, y, deltaX, deltaY }) => {
    const result = await apiPost("/setup-api/browser", {
      action: "scroll", x, y,
      ...(deltaX !== undefined ? { deltaX } : {}),
      deltaY,
    });
    const parts: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [];
    parts.push({ type: "text", text: `Scrolled at (${x}, ${y}) by deltaY=${deltaY}` });
    if (result.screenshot) {
      parts.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
    }
    return { content: parts };
  }
);

server.tool(
  "browser_screenshot",
  "Take a screenshot of the current browser page",
  async () => {
    const result = await apiPost("/setup-api/browser", { action: "screenshot" });
    const parts: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] = [];
    parts.push({ type: "text", text: "Screenshot captured." });
    if (result.screenshot) {
      parts.push({ type: "image", data: result.screenshot, mimeType: "image/png" });
    }
    return { content: parts };
  }
);

server.tool(
  "browser_close",
  "Close the browser session",
  async () => {
    await apiPost("/setup-api/browser", { action: "close" });
    return { content: [{ type: "text", text: "Browser session closed." }] };
  }
);

// ── App Store ──

server.tool(
  "app_search",
  "Search the ClawBox app store for skills and extensions",
  {
    query: z.string().optional().describe("Search query"),
    category: z.string().optional().describe("Filter by category"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, category, limit }) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category) params.set("category", category);
    if (limit) params.set("limit", String(limit));
    const data = await api(`/setup-api/apps/store?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "app_install",
  "Install a skill/app from the ClawBox app store",
  {
    appId: z.string().describe("App ID to install (from app_search results)"),
  },
  async ({ appId }) => {
    await apiPost("/setup-api/apps/install", { appId });
    return { content: [{ type: "text", text: `App '${appId}' installed successfully.` }] };
  }
);

server.tool(
  "app_uninstall",
  "Uninstall a skill/app from ClawBox",
  {
    appId: z.string().describe("App ID to uninstall"),
  },
  async ({ appId }) => {
    await apiPost("/setup-api/apps/uninstall", { appId });
    return { content: [{ type: "text", text: `App '${appId}' uninstalled.` }] };
  }
);

// ── Network ──

server.tool(
  "wifi_scan",
  "Scan for available WiFi networks",
  async () => {
    const data = await api("/setup-api/wifi/scan");
    return { content: [{ type: "text", text: JSON.stringify(data.networks, null, 2) }] };
  }
);

server.tool(
  "wifi_status",
  "Get current WiFi connection status",
  async () => {
    const data = await api("/setup-api/wifi/status");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── VNC (Remote Desktop) ──

server.tool(
  "vnc_status",
  "Check VNC remote desktop server status and connection info",
  async () => {
    const data = await api("/setup-api/vnc");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Preferences & Config ──

server.tool(
  "preferences_get",
  "Get ClawBox user preferences",
  {
    keys: z.string().optional().describe("Comma-separated preference keys to retrieve (omit for all)"),
  },
  async ({ keys }) => {
    const params = keys ? `?keys=${encodeURIComponent(keys)}` : "";
    const data = await api(`/setup-api/preferences${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "preferences_set",
  "Set ClawBox user preferences (keys must start with: wp_, desktop_, ui_, app_, installed_, icon_, pinned_, hidden_, ff_)",
  {
    preferences: z.string().describe("JSON string of key-value pairs to save"),
  },
  async ({ preferences }) => {
    const parsed = JSON.parse(preferences);
    await apiPost("/setup-api/preferences", parsed);
    return { content: [{ type: "text", text: `Preferences updated: ${Object.keys(parsed).join(", ")}` }] };
  }
);

// ── UI Control (opens apps in ClawBox desktop) ──

const AVAILABLE_APPS = [
  { id: "settings", name: "Settings", description: "Device settings and configuration" },
  { id: "openclaw", name: "OpenClaw", description: "AI chat interface" },
  { id: "terminal", name: "Terminal", description: "Command-line shell" },
  { id: "files", name: "Files", description: "File manager" },
  { id: "store", name: "Store", description: "App store for skills and extensions" },
  { id: "browser", name: "Browser", description: "Web browser" },
  { id: "vnc", name: "Remote Desktop", description: "VNC remote desktop viewer" },
  { id: "vscode", name: "VS Code", description: "Code editor" },
];

server.tool(
  "ui_open_app",
  "Open an app in the ClawBox desktop UI. The app window will appear on the user's screen.",
  {
    appId: z.string().describe("App ID to open. Available: settings, openclaw, terminal, files, store, browser, vnc, vscode. For installed apps use: installed-<appId>"),
  },
  async ({ appId }) => {
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({ type: "open_app", appId, ts: Date.now() }),
    });
    const app = AVAILABLE_APPS.find(a => a.id === appId);
    const name = app?.name ?? appId;
    return { content: [{ type: "text", text: `Opening ${name} on the ClawBox desktop.` }] };
  }
);

server.tool(
  "ui_list_apps",
  "List all available apps that can be opened in the ClawBox desktop UI",
  async () => {
    // Also fetch installed apps
    let installed: { id: string; name: string }[] = [];
    try {
      const result = await runShell("ls /home/clawbox/.openclaw/skills/ 2>/dev/null");
      if (result.exitCode === 0) {
        installed = result.stdout.trim().split("\n").filter(Boolean).map(name => ({
          id: `installed-${name}`,
          name,
        }));
      }
    } catch {}
    const all = [
      ...AVAILABLE_APPS.map(a => `${a.id} — ${a.name}: ${a.description}`),
      ...installed.map(a => `${a.id} — ${a.name} (installed skill)`),
    ];
    return { content: [{ type: "text", text: `Available apps:\n${all.join("\n")}` }] };
  }
);

server.tool(
  "ui_notify",
  "Show a notification toast on the ClawBox desktop UI",
  {
    message: z.string().describe("Notification message to display"),
  },
  async ({ message }) => {
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({ type: "notify", message, ts: Date.now() }),
    });
    return { content: [{ type: "text", text: `Notification sent: "${message}"` }] };
  }
);

// ── Custom Webapp Creation ──

server.tool(
  "webapp_create",
  `Create a custom web app and add it to the ClawBox desktop. The app appears as a desktop icon that opens in a window.

WORKFLOW:
1. Write the full app as a single self-contained HTML file (inline CSS + JS, no external deps)
2. This tool saves the HTML, registers the desktop icon, and opens it automatically
3. The user can immediately see and interact with the app

GUIDELINES:
- Write complete, standalone HTML with all CSS/JS inline
- Use modern CSS (flexbox/grid) and vanilla JS
- For a polished look, use a dark theme: background #1a1a2e, text #e0e0e0, accent #f97316
- The app runs in a sandboxed iframe — no access to parent page
- Keep it self-contained: no external CDN links (device may be offline)`,
  {
    appId: z.string().describe("Unique ID for the app (lowercase, hyphens ok, e.g. 'calculator', 'todo-list')"),
    name: z.string().describe("Display name shown under the desktop icon (e.g. 'Calculator')"),
    html: z.string().describe("Complete self-contained HTML file content with inline CSS and JS"),
    color: z.string().optional().describe("Icon background color hex (default: #f97316)"),
    openAfterCreate: z.boolean().optional().describe("Open the app window immediately after creating (default: true)"),
  },
  async ({ appId, name, html, color, openAfterCreate }) => {
    // 1. Save the webapp HTML via API
    const saveResult = await apiPost("/setup-api/webapps", {
      appId,
      html,
      name,
      color: color || "#f97316",
    });

    const url = (saveResult as { url?: string }).url || `/setup-api/webapps?app=${appId}`;

    // 2. Register the app on the desktop via KV action
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({
        type: "register_webapp",
        appId,
        name,
        color: color || "#f97316",
        url,
        ts: Date.now(),
      }),
    });

    // 3. Wait a moment for UI to pick up registration, then open
    if (openAfterCreate !== false) {
      await new Promise(r => setTimeout(r, UI_PICKUP_DELAY_MS));
      await apiPost("/setup-api/kv", {
        key: "ui:pending-action",
        value: JSON.stringify({ type: "open_app", appId: `installed-${appId}`, ts: Date.now() }),
      });
    }

    return {
      content: [{
        type: "text",
        text: `Created webapp "${name}" (${appId}). ${openAfterCreate !== false ? "Opening on desktop..." : "Added to desktop."}`,
      }],
    };
  }
);

server.tool(
  "webapp_update",
  "Update the HTML content of an existing custom webapp. The app will show the new content on next open/refresh.",
  {
    appId: z.string().describe("App ID of the webapp to update"),
    html: z.string().describe("Updated HTML content"),
  },
  async ({ appId, html }) => {
    await apiPost("/setup-api/webapps", { appId, html });
    return { content: [{ type: "text", text: `Webapp "${appId}" updated.` }] };
  }
);

// ── Start Server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[clawbox-mcp] Server started on stdio");
}

main().catch((err) => {
  console.error("[clawbox-mcp] Fatal error:", err);
  process.exit(1);
});
