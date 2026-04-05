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

  } else if (cmd === "code" && sub === "init") {
    const projectId = args[2];
    const name = args[3];
    const template = args[4] && !args[4].startsWith("--") ? args[4] : "app";
    const color = args[5] && !args[5].startsWith("--") ? args[5] : "#f97316";
    if (!projectId || !name) {
      console.error("Usage: clawbox code init <projectId> <name> [template] [color]");
      process.exit(1);
    }
    const data = await apiPost("/setup-api/code", {
      action: "init", projectId, name, template, color,
    });
    console.log(`✅ Created project "${name}" (${projectId})`);
    console.log(JSON.stringify(data, null, 2));

  } else if (cmd === "code" && sub === "list") {
    const data = await apiPost("/setup-api/code", { action: "list-projects" });
    console.log(JSON.stringify(data, null, 2));

  } else if (cmd === "code" && sub === "files") {
    const projectId = args[2];
    if (!projectId) {
      console.error("Usage: clawbox code files <projectId>");
      process.exit(1);
    }
    const data = await apiPost("/setup-api/code", { action: "file-list", projectId });
    console.log(JSON.stringify(data, null, 2));

  } else if (cmd === "code" && sub === "read") {
    const projectId = args[2];
    const filePath = args[3];
    if (!projectId || !filePath) {
      console.error("Usage: clawbox code read <projectId> <filePath>");
      process.exit(1);
    }
    const data = await apiPost("/setup-api/code", { action: "file-read", projectId, filePath }) as { content: string };
    console.log(data.content);

  } else if (cmd === "code" && sub === "write") {
    const projectId = args[2];
    const filePath = args[3];
    if (!projectId || !filePath) {
      console.error("Usage: clawbox code write <projectId> <filePath> --content '...' OR pipe via stdin");
      process.exit(1);
    }
    const contentIdx = args.indexOf("--content");
    let content: string;
    if (contentIdx !== -1 && contentIdx + 1 < args.length && !args[contentIdx + 1].startsWith("--")) {
      content = args[contentIdx + 1];
    } else {
      content = await readStdin();
    }
    await apiPost("/setup-api/code", { action: "file-write", projectId, filePath, content });
    console.log(`✅ Written: ${filePath}`);

  } else if (cmd === "code" && sub === "edit") {
    const projectId = args[2];
    const filePath = args[3];
    const oldIdx = args.indexOf("--old");
    const newIdx = args.indexOf("--new");
    if (!projectId || !filePath || oldIdx === -1 || newIdx === -1 ||
        oldIdx + 1 >= args.length || newIdx + 1 >= args.length) {
      console.error("Usage: clawbox code edit <projectId> <filePath> --old 'old text' --new 'new text'");
      process.exit(1);
    }
    const oldString = args[oldIdx + 1];
    const newString = args[newIdx + 1];
    const data = await apiPost("/setup-api/code", { action: "file-edit", projectId, filePath, oldString, newString });
    console.log(`✅ Edited ${filePath}`);
    console.log(JSON.stringify(data, null, 2));

  } else if (cmd === "code" && sub === "search") {
    const projectId = args[2];
    const pattern = args[3];
    if (!projectId || !pattern) {
      console.error("Usage: clawbox code search <projectId> <pattern>");
      process.exit(1);
    }
    const data = await apiPost("/setup-api/code", { action: "search", projectId, pattern });
    console.log(JSON.stringify(data, null, 2));

  } else if (cmd === "code" && sub === "build") {
    const projectId = args[2];
    if (!projectId) {
      console.error("Usage: clawbox code build <projectId>");
      process.exit(1);
    }
    const data = await apiPost("/setup-api/code", { action: "build", projectId }) as { url: string; filesInlined: number };

    // Register on desktop
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({
        type: "register_webapp",
        appId: projectId,
        name: projectId,
        color: "#f97316",
        url: data.url,
        ts: Date.now(),
      }),
    });

    // Wait for UI pickup, then open
    await new Promise(r => setTimeout(r, UI_PICKUP_DELAY_MS));
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({ type: "open_app", appId: `installed-${projectId}`, ts: Date.now() }),
    });

    console.log(`✅ Built and deployed "${projectId}" (${data.filesInlined} files inlined) — opening on desktop.`);

  } else if (cmd === "code" && sub === "delete") {
    const projectId = args[2];
    if (!projectId) {
      console.error("Usage: clawbox code delete <projectId>");
      process.exit(1);
    }
    await apiPost("/setup-api/code", { action: "delete-project", projectId });
    console.log(`✅ Deleted project "${projectId}".`);

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

Code Projects:
  clawbox code init <projectId> <name> [template] [color]
  clawbox code list
  clawbox code files <projectId>
  clawbox code read <projectId> <filePath>
  clawbox code write <projectId> <filePath> --content '...'
  clawbox code edit <projectId> <filePath> --old 'old' --new 'new'
  clawbox code search <projectId> <pattern>
  clawbox code build <projectId>
  clawbox code delete <projectId>

Examples:
  clawbox webapp create calculator Calculator '#4CAF50' --html '<!DOCTYPE html><html>...</html>'
  clawbox app open files
  clawbox app open installed-calculator
  clawbox notify "Build complete!"
  clawbox code init weather-app "Weather App"
  clawbox code build weather-app
`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
