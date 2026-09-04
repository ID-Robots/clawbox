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
 *   clawbox update
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { installEdition, resolveAppHarness, type Ed } from "./lib/edition";
import { builtInApps } from "./lib/context";
import { HARNESS_ONLY_APP_IDS, isInstalledAppVisible } from "../src/lib/desktop-app-editions";
import { INSTALLED_APP_ID_RE } from "./lib/schema";

const API_BASE = process.env.CLAWBOX_API_BASE || "http://127.0.0.1:80";
const UI_PICKUP_DELAY_MS = 2500; // Time for the desktop UI to poll and pick up KV actions

// MCP bearer token. /setup-api/* is session-gated by src/middleware.ts once
// setup completes, but it also accepts this per-install bearer (see
// src/lib/mcp-token.ts) in lieu of a session cookie. Without it every call is
// 307'd to /login and we'd JSON.parse the login HTML — the classic
// "invalid JSON response: Failed to parse JSON" failure. clawbox-mcp.ts reads
// this from its env; the CLI is launched separately (from the agent's shell)
// which may not inherit that env, so fall back to the on-disk token the
// gateway pre-start script wrote. Loaded lazily so token-free commands like
// `app list` still work without it.
let cachedToken: string | null = null;
function findApiToken(): string | null {
  if (cachedToken) return cachedToken;
  const fromEnv = process.env.CLAWBOX_MCP_TOKEN;
  if (fromEnv && fromEnv.length >= 16) {
    cachedToken = fromEnv;
    return fromEnv;
  }
  // Mirror src/lib/mcp-token.ts so a dev/local CLI run finds the same token
  // file the server wrote under the cwd, not just the on-device install path.
  const root = process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  try {
    const raw = readFileSync(join(root, "data", ".mcp-token"), "utf-8").trim();
    if (raw.length >= 16) {
      cachedToken = raw;
      return raw;
    }
  } catch {
    // No token file — the caller decides whether that is fatal.
  }
  return null;
}

function getApiToken(): string {
  const token = findApiToken();
  if (token) return token;
  console.error("MCP token not found: set CLAWBOX_MCP_TOKEN or ensure data/.mcp-token exists (is the gateway pre-start script running?).");
  process.exit(1);
}

/**
 * Which harness's built-in apps this box has — or null, when that could not be
 * determined.
 *
 * NOT `installEdition() === "hermes" ? … : "openclaw"`. That answer has THREE
 * values — the premium `dual` SKU carries both harnesses — and folding `dual`
 * into `openclaw` refused `clawbox app open hermes` on a dual box that is
 * running Hermes, while the desktop opened that dashboard from the ACTIVE
 * harness and `ui_open_app` allowed it. One question, three surfaces, and the
 * CLI was the one giving a different answer.
 *
 * `resolveAppHarness` is that same resolution: a locked edition decides on its
 * own, only `dual` asks the device which harness is active, and an unreadable
 * lock or a device that does not answer is NULL rather than a guess — see the
 * note there on why an app gate cannot fail closed onto one harness. The
 * bearer is OPTIONAL — `app list` has always worked without a token, and the
 * cost is only that a session-gated device leaves the dual question
 * unresolved rather than answering it.
 */
function openHarness(): Promise<Ed | null> {
  const token = findApiToken();
  return resolveAppHarness(API_BASE, token ? `Bearer ${token}` : null);
}

/** Why an app that exists on ONE harness cannot be opened right now. */
const UNKNOWN_HARNESS_NOTE =
  "This ClawBox could not say which harness it is running, so apps that belong to only one of them"
  + " are not offered. Check /etc/clawbox/edition.env and that the device's web server is up.";

async function api(path: string, options?: RequestInit) {
  const headers = new Headers(options?.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${getApiToken()}`);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    console.error("The device rejected this request's token. Check data/.mcp-token, or restart the device.");
    process.exit(1);
  }
  if (!res.ok) {
    // Never echo the upstream body: route errors carry python tracebacks,
    // binary paths and occasionally a token an upstream reflected back.
    console.error(`The device refused this request (HTTP ${res.status}). Check the device logs for details.`);
    process.exit(1);
  }
  try {
    return await res.json();
  } catch {
    console.error("The device returned a response this command could not read.");
    process.exit(1);
  }
}

async function apiPost(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readStdin(): Promise<string> {
  // If stdin is a TTY, no piped input is coming — fail fast instead of hanging
  // forever waiting for the user to type EOF.
  if (process.stdin.isTTY) {
    console.error("No input on stdin (and no --html/--content flag provided).");
    process.exit(1);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const args = process.argv.slice(2);
const cmd = args[0];
const sub = args[1];

/**
 * Value of a `--flag value` pair.
 *
 * The old form additionally required the value NOT to start with "--", so
 * `--content "--force is now the default"` silently discarded the value and
 * fell through to reading stdin, which then blocked forever or wrote an empty
 * file. A flag that is present with no following argument is now an error, not
 * a silent fallback.
 */
function flagValue(name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const value = args[i + 1];
  if (value === undefined) {
    console.error(`${name} needs a value.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  if (cmd === "webapp" && sub === "create") {
    const appId = args[2];
    const name = args[3];
    const color = args[4] && !args[4].startsWith("--") ? args[4] : "#f97316";
    if (!appId || !name) {
      console.error("Usage: clawbox webapp create <appId> <name> [color] --html '<html>...' OR pipe HTML via stdin");
      process.exit(1);
    }

    // Get HTML from --html flag or stdin (don't capture another flag as content)
    const html = flagValue("--html") ?? (await readStdin());

    if (!html.trim()) {
      console.error("No HTML content provided. Use --html '<html>...' or pipe via stdin.");
      process.exit(1);
    }

    // 1. Save webapp
    await apiPost("/setup-api/webapps", { appId, html, name, color });

    // 2. Register on desktop. The legacy single-slot key is what this process
    // can address; /setup-api/kv folds it into the owner-notice ring
    // (src/lib/pending-actions.ts) that every open desktop polls.
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
    const html = flagValue("--html") ?? (await readStdin());
    await apiPost("/setup-api/webapps", { appId, html });
    console.log(`✅ Updated webapp "${appId}".`);

  } else if (cmd === "app" && sub === "open") {
    const appId = args[2];
    if (!appId) {
      console.error("Usage: clawbox app open <appId>");
      process.exit(1);
    }
    // Same gate ui_open_app applies. Without it this printed "Opening x" for a
    // typo, for an installed id missing its `installed-` prefix, and for the
    // other harness's apps — a false success on the CLI sibling of the list
    // `app list` below prints from.
    const harness = await openHarness();
    const openable = builtInApps(harness).map((a) => a.id);
    const isInstalled = appId.startsWith("installed-");
    if (isInstalled) {
      // The shape check, exactly where ui_open_app applies it: an installed id
      // is caller-supplied, and `installed-../etc` would otherwise be posted as
      // a pending action with a tick printed over it.
      if (!INSTALLED_APP_ID_RE.test(appId)) {
        console.error(`"${appId}" is not a valid installed-app id.`);
        process.exit(1);
      }
      // …and then MEMBERSHIP, also where ui_open_app applies it. A well-formed
      // id the device does not have is still a window that never opens, and
      // printing a tick over it is the same false success the built-in branch
      // below exists to stop.
      //
      // …and MEMBERSHIP IN WHAT THE DESKTOP WOULD OPEN, not merely in
      // `installed_apps`: a store-installed OpenClaw skill is unusable on
      // Hermes (its window shells out to the openclaw binary), so the desktop
      // drops it and a tick here would be printed over a window that never
      // appears. One predicate, shared with the desktop and with ui_open_app.
      const prefs = await api("/setup-api/preferences?keys=installed_apps,installed_meta") as {
        installed_apps?: unknown;
        installed_meta?: unknown;
      };
      const meta = (prefs?.installed_meta ?? {}) as Record<string, { webappUrl?: unknown } | undefined>;
      const installed = (Array.isArray(prefs?.installed_apps)
        ? prefs.installed_apps.filter((v): v is string => typeof v === "string")
        : []
      ).filter((id) => isInstalledAppVisible(meta[id], harness));
      if (!installed.includes(appId.slice("installed-".length))) {
        console.error(
          `No installed app "${appId.slice("installed-".length)}" this ClawBox can open.`
          + (installed.length ? ` Installed: ${installed.join(", ")}` : " Nothing is installed."),
        );
        process.exit(1);
      }
    } else if (!openable.includes(appId)) {
      // An app the OTHER harness owns is "not here"; the same app while the
      // harness is unknown is "could not be placed". Saying the first over the
      // second tells the agent as a durable fact that a dual box has no
      // dashboard, which is how it stops asking.
      console.error(
        harness === null && HARNESS_ONLY_APP_IDS.includes(appId)
          ? `Cannot open "${appId}": ${UNKNOWN_HARNESS_NOTE}`
          : `No built-in app "${appId}" on this ClawBox. Try: ${openable.join(", ")}`,
      );
      process.exit(1);
    }
    await apiPost("/setup-api/kv", {
      key: "ui:pending-action",
      value: JSON.stringify({ type: "open_app", appId, ts: Date.now() }),
    });
    console.log(`✅ Opening ${appId} on desktop.`);

  } else if (cmd === "app" && sub === "list") {
    // The list is HARNESS-dependent: a Hermes device has no OpenClaw chat app
    // and no app store, and printing them sends the user to a window that
    // cannot open. Same resolution as `app open` above, so the list and the
    // gate can never name different apps.
    const edition = installEdition();
    const harness = await openHarness();
    console.log(
      harness === null
        ? `Built-in apps (${edition} edition, harness undetermined):`
        : edition === harness
          ? `Built-in apps (${edition} edition):`
          : `Built-in apps (${edition} edition, running ${harness}):`,
    );
    for (const app of builtInApps(harness)) console.log(`  ${app.id} — ${app.name}`);
    if (harness === null) console.log(`  (${UNKNOWN_HARNESS_NOTE})`);

  } else if (cmd === "edition") {
    console.log(installEdition());

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
    const content = flagValue("--content") ?? (await readStdin());
    await apiPost("/setup-api/code", { action: "file-write", projectId, filePath, content });
    console.log(`✅ Written: ${filePath}`);

  } else if (cmd === "code" && sub === "edit") {
    const projectId = args[2];
    const filePath = args[3];
    const oldString = flagValue("--old");
    const newString = flagValue("--new");
    if (!projectId || !filePath || oldString === null || newString === null) {
      console.error("Usage: clawbox code edit <projectId> <filePath> --old 'old text' --new 'new text'");
      process.exit(1);
    }
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

  } else if (cmd === "update") {
    // Re-running install.sh on a Hermes device risks unmasking the OpenClaw
    // gateway and breaking the edition lock, which is a support call, not an
    // update. Updating a Hermes box is done from Settings -> System Update.
    if (installEdition() === "hermes") {
      console.error("This is a Hermes-edition ClawBox: `clawbox update` would re-run the OpenClaw installer and break the edition lock.");
      console.error("Update it from Settings -> System Update on the desktop instead.");
      process.exit(1);
    }
    // ClawBox system update: re-run the full installer in place. It git-syncs
    // to the latest pinned code, then runs every step (system packages,
    // OpenClaw at the pinned version, gateway config) and rebuilds — the same
    // complete path the Settings -> Update button drives, but straight in the
    // terminal so you can watch each step and see exactly where it fails.
    // Requires root, so it shells out via sudo.
    const projectRoot = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
    // Validate CLAWBOX_ROOT against the same SAFE_PATH guard as
    // scripts/force-update.sh + updater.ts — a malicious env value would
    // otherwise let `sudo bash` run an attacker-controlled script.
    if (!/^[A-Za-z0-9._/-]+$/.test(projectRoot)) {
      console.error(`Invalid CLAWBOX_ROOT '${projectRoot}' (allowed: A-Z a-z 0-9 . _ / -)`);
      process.exit(1);
    }
    const installScript = join(projectRoot, "install.sh");
    if (!existsSync(installScript)) {
      console.error(`install.sh not found at ${installScript} — set CLAWBOX_ROOT to your ClawBox checkout.`);
      process.exit(1);
    }
    console.log(`Running ClawBox update — sudo bash ${installScript}\n`);
    const res = spawnSync("sudo", ["bash", installScript], { stdio: "inherit" });
    process.exit(res.status ?? 1);

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
  clawbox edition                      Print this device's edition (openclaw | hermes | dual)
  clawbox update                       Update ClawBox + OpenClaw in place (OpenClaw edition only; runs the installer, needs sudo)

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
