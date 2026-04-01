#!/usr/bin/env bun
/**
 * ClawBox CLI — Shell-callable wrapper for MCP tools.
 * Used by the AI agent via `exec` when MCP tool calling isn't available.
 *
 * Usage:
 *   clawbox webapp create <appId> <name> [color] < html_file
 *   clawbox webapp create <appId> <name> [color] --html "<html>..."
 *   clawbox webapp update <appId> < html_file
 *   clawbox app open <appId>
 *   clawbox app list
 *   clawbox notify <message>
 *   clawbox system stats
 *   clawbox system info
 */

const API_BASE = process.env.CLAWBOX_API_BASE || "http://127.0.0.1:80";
const UI_PICKUP_DELAY_MS = 2500; // Time for the desktop UI to poll and pick up KV actions

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Error ${res.status}: ${body}`);
    process.exit(1);
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

async function main() {
  if (cmd === "webapp" && sub === "create") {
    const appId = args[2];
    const name = args[3];
    const color = args[4] && !args[4].startsWith("--") ? args[4] : "#f97316";
    if (!appId || !name) {
      console.error("Usage: clawbox webapp create <appId> <name> [color] --html '<html>...' OR pipe HTML via stdin");
      process.exit(1);
    }

    // Get HTML from --html flag or stdin
    let html: string;
    const htmlIdx = args.indexOf("--html");
    if (htmlIdx !== -1 && args[htmlIdx + 1]) {
      html = args[htmlIdx + 1];
    } else {
      html = await readStdin();
    }

    if (!html.trim()) {
      console.error("No HTML content provided. Use --html '<html>...' or pipe via stdin.");
      process.exit(1);
    }

    // 1. Save webapp
    await apiPost("/setup-api/webapps", { appId, html, name, color });

    // 2. Register on desktop
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({
        type: "register_webapp",
        appId,
        name,
        color,
        url: `/setup-api/webapps?app=${appId}`,
        ts: Date.now(),
      }),
    });

    // 3. Wait for UI to pick up, then open
    await new Promise(r => setTimeout(r, UI_PICKUP_DELAY_MS));
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({ type: "open_app", appId: `installed-${appId}`, ts: Date.now() }),
    });

    console.log(`✅ Created webapp "${name}" (${appId}) — opening on desktop.`);

  } else if (cmd === "webapp" && sub === "update") {
    const appId = args[2];
    if (!appId) {
      console.error("Usage: clawbox webapp update <appId> --html '<html>...' OR pipe HTML via stdin");
      process.exit(1);
    }
    const htmlIdx = args.indexOf("--html");
    let html: string;
    if (htmlIdx !== -1 && args[htmlIdx + 1]) {
      html = args[htmlIdx + 1];
    } else {
      html = await readStdin();
    }
    await apiPost("/setup-api/webapps", { appId, html });
    console.log(`✅ Updated webapp "${appId}".`);

  } else if (cmd === "app" && sub === "open") {
    const appId = args[2];
    if (!appId) {
      console.error("Usage: clawbox app open <appId>");
      process.exit(1);
    }
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({ type: "open_app", appId, ts: Date.now() }),
    });
    console.log(`✅ Opening ${appId} on desktop.`);

  } else if (cmd === "app" && sub === "list") {
    const builtIn = ["settings", "openclaw", "terminal", "files", "store", "browser", "vnc", "vscode"];
    console.log("Built-in apps:");
    builtIn.forEach(a => console.log(`  ${a}`));

  } else if (cmd === "notify") {
    const message = args.slice(1).join(" ");
    if (!message) {
      console.error("Usage: clawbox notify <message>");
      process.exit(1);
    }
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({ type: "notify", message, ts: Date.now() }),
    });
    console.log(`✅ Notification sent.`);

  } else if (cmd === "system" && sub === "stats") {
    const data = await api("/setup-api/system/stats");
    console.log(JSON.stringify(data, null, 2));

  } else if (cmd === "system" && sub === "info") {
    const data = await api("/setup-api/system/info");
    console.log(JSON.stringify(data, null, 2));

  } else {
    console.log(`ClawBox CLI — Control the ClawBox device

Usage:
  clawbox webapp create <appId> <name> [color] --html "<html>..."
  clawbox webapp create <appId> <name> [color] < file.html
  clawbox webapp update <appId> --html "<html>..."
  clawbox app open <appId>
  clawbox app list
  clawbox notify <message>
  clawbox system stats
  clawbox system info

Examples:
  clawbox webapp create calculator Calculator '#4CAF50' --html '<!DOCTYPE html><html>...</html>'
  clawbox app open files
  clawbox app open installed-calculator
  clawbox notify "Build complete!"
`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
