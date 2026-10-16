import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { prettifyToolName, toolBrand, TOOL_STEP_APPS, type ToolBrand } from "@/lib/chat-tool-events";
import { APP_GLYPHS, apps } from "@/lib/desktop-apps";
import { translations } from "@/lib/translations";

/**
 * A chat step that is really a ClawBox app reads as that app.
 *
 * The rows used to show whatever the wire said. Two of those were seen on a
 * box: Claude Code calling OpenClaw's `memory_search` through OpenClaw's MCP
 * bridge arrives as `mcp__openclaw__memory_search`, and only the FIRST server
 * prefix was stripped, so the row read "openclaw memory search"; and a shell
 * step that ran `openclaw memory search …` was labelled by its tool, `exec`
 * or `Bash`. Both now say "Memory Shard Search".
 */

describe("the screenshot's row", () => {
  it("names a gateway tool reached through the Claude CLI's MCP bridge by its app", () => {
    expect(prettifyToolName("mcp__openclaw__memory_search")).toBe("Memory Shard Search");
    expect(toolBrand("mcp__openclaw__memory_search")).toBe("memory-shard");
  });

  it("names a shell step that runs the openclaw memory CLI by its app", () => {
    expect(prettifyToolName("Bash", "openclaw memory search \"router vlan\"")).toBe("Memory Shard Search");
    expect(prettifyToolName("exec", "openclaw memory search \"router vlan\"")).toBe("Memory Shard Search");
    expect(toolBrand("exec", "openclaw memory search \"router vlan\"")).toBe("memory-shard");
  });

  it("leaves the harness's own Grep alone", () => {
    expect(prettifyToolName("Grep")).toBe("Grep");
    expect(toolBrand("Grep")).toBeNull();
  });
});

// Every mapping in the table, as the wire names it. Not derived from the table
// on purpose: this list is the review copy of it, so a row that changes app or
// label has to change here too.
const TOOL_ROWS: [wire: string, label: string, brand: ToolBrand][] = [
  // Memory Shard
  ["memory_search", "Memory Shard Search", "memory-shard"],
  ["memory_get", "Memory Shard Read", "memory-shard"],
  ["clawbox__memory_shard_search", "Memory Shard Search", "memory-shard"],
  ["mcp_clawbox_memory_shard_search", "Memory Shard Search", "memory-shard"],
  ["mcp_clawbox_memory_shard_status", "Memory Shard Status", "memory-shard"],
  // Prime Radiant
  ["wiki_status", "Prime Radiant Status", "prime-radiant"],
  ["wiki_search", "Prime Radiant Search", "prime-radiant"],
  ["wiki_get", "Prime Radiant Page", "prime-radiant"],
  ["wiki_apply", "Prime Radiant Update", "prime-radiant"],
  ["wiki_lint", "Prime Radiant Checks", "prime-radiant"],
  ["openclaw__wiki_search", "Prime Radiant Search", "prime-radiant"],
  ["mcp__openclaw__wiki_get", "Prime Radiant Page", "prime-radiant"],
  ["clawbox__prime_radiant_status", "Prime Radiant Status", "prime-radiant"],
  ["clawbox__prime_radiant_pages", "Prime Radiant List", "prime-radiant"],
  ["clawbox__prime_radiant_page", "Prime Radiant Page", "prime-radiant"],
  ["mcp_clawbox_prime_radiant_search", "Prime Radiant Search", "prime-radiant"],
  ["clawbox__prime_radiant_map", "Prime Radiant Map", "prime-radiant"],
  ["clawbox__prime_radiant_lint", "Prime Radiant Checks", "prime-radiant"],
  ["clawbox__prime_radiant_costs", "Prime Radiant Usage", "prime-radiant"],
  ["clawbox__prime_radiant_settings", "Prime Radiant Settings", "prime-radiant"],
  ["clawbox__prime_radiant_review_list", "Prime Radiant Review", "prime-radiant"],
  ["clawbox__prime_radiant_history", "Prime Radiant History", "prime-radiant"],
  ["clawbox__prime_radiant_diff", "Prime Radiant History", "prime-radiant"],
  ["clawbox__prime_radiant_ingest_status", "Prime Radiant Import", "prime-radiant"],
  ["clawbox__prime_radiant_page_create", "Prime Radiant Create", "prime-radiant"],
  ["mcp__clawbox__prime_radiant_page_edit", "Prime Radiant Update", "prime-radiant"],
  ["clawbox__prime_radiant_page_delete", "Prime Radiant Remove", "prime-radiant"],
  ["clawbox__prime_radiant_claim_add", "Prime Radiant Create", "prime-radiant"],
  ["clawbox__prime_radiant_claim_edit", "Prime Radiant Update", "prime-radiant"],
  ["clawbox__prime_radiant_claim_delete", "Prime Radiant Remove", "prime-radiant"],
  ["clawbox__prime_radiant_claim_verify", "Prime Radiant Verify", "prime-radiant"],
  ["clawbox__prime_radiant_review_resolve", "Prime Radiant Review", "prime-radiant"],
  ["mcp_clawbox_prime_radiant_review_raise", "Prime Radiant Review", "prime-radiant"],
  ["clawbox__prime_radiant_undo", "Prime Radiant Undo", "prime-radiant"],
  ["clawbox__prime_radiant_ingest_preview", "Prime Radiant Import", "prime-radiant"],
  ["clawbox__prime_radiant_ingest_start", "Prime Radiant Import", "prime-radiant"],
  ["clawbox__prime_radiant_ingest_stop", "Prime Radiant Stop", "prime-radiant"],
  ["clawbox__prime_radiant_ingest_retry", "Prime Radiant Import", "prime-radiant"],
  ["clawbox__prime_radiant_nightly_run", "Prime Radiant Run", "prime-radiant"],
  ["clawbox__prime_radiant_nightly_merge", "Prime Radiant Update", "prime-radiant"],
  ["clawbox__prime_radiant_connect_run", "Prime Radiant Run", "prime-radiant"],
  ["clawbox__prime_radiant_settings_update", "Prime Radiant Settings", "prime-radiant"],
  // ClawKeep
  ["clawbox__backup_status", "ClawKeep Status", "clawkeep"],
  ["clawbox__backup_list", "ClawKeep List", "clawkeep"],
  ["mcp_clawbox_backup_now", "ClawKeep Backup", "clawkeep"],
  // Coding Agent
  ["clawbox__coding_agent_run", "Coding Agent Start", "coding"],
  ["clawbox__coding_agent_status", "Coding Agent Status", "coding"],
  ["clawbox__coding_agent_stop", "Coding Agent Stop", "coding"],
  ["clawbox__coding_agent_resume", "Coding Agent Resume", "coding"],
  ["clawbox__coding_run_message", "Coding Agent Message", "coding"],
  ["clawbox__coding_run_list", "Coding Agent List", "coding"],
  ["clawbox__coding_project_status", "Coding Agent Status", "coding"],
  ["clawbox__coding_secret_list", "Coding Agent List", "coding"],
  ["clawbox__coding_team_run", "Coding Agent Start", "coding"],
  ["clawbox__coding_team_status", "Coding Agent Status", "coding"],
  ["clawbox__coding_team_stop", "Coding Agent Stop", "coding"],
  ["mcp__clawbox__team_message", "Coding Agent Message", "coding"],
  ["clawbox__anthropic_accounts", "Coding Agent", "coding"],
  // Agent Browser — ClawBox's own browser tools only
  ["clawbox__browser_open", "Agent Browser Open", "browser"],
  ["clawbox__browser_navigate", "Agent Browser Open", "browser"],
  ["mcp__clawbox__browser_screenshot", "Agent Browser Screenshot", "browser"],
  ["clawbox__browser_close", "Agent Browser Close", "browser"],
  ["clawbox__browser_click", "Agent Browser Click", "browser"],
  ["clawbox__browser_type", "Agent Browser Type", "browser"],
  ["clawbox__browser_fill", "Agent Browser Type", "browser"],
  ["clawbox__browser_keypress", "Agent Browser Type", "browser"],
  ["clawbox__browser_scroll", "Agent Browser Scroll", "browser"],
  ["mcp__clawbox__browser_view_local", "Agent Browser Open", "browser"],
  ["mcp_clawbox_browser_open", "Agent Browser Open", "browser"],
  // Remote Desktop, Screenshot
  ["clawbox__vnc_status", "Remote Desktop Status", "vnc"],
  ["clawbox__screen_capture", "Screenshot", "screenshot"],
  // Store, Skills
  ["clawbox__app_search", "Store Search", "store"],
  ["clawbox__app_install", "Store Install", "store"],
  ["clawbox__app_uninstall", "Store Uninstall", "store"],
  ["mcp_clawbox_skill_search", "Skills Search", "hermes-skills"],
  ["mcp_clawbox_skill_list", "Skills List", "hermes-skills"],
  ["mcp_clawbox_skill_info", "Skills Read", "hermes-skills"],
  ["mcp_clawbox_skill_install", "Skills Install", "hermes-skills"],
  ["mcp_clawbox_skill_uninstall", "Skills Uninstall", "hermes-skills"],
  ["skills_list", "Skills List", "hermes-skills"],
  ["skill_view", "Skills Read", "hermes-skills"],
  ["skill_manage", "Skills Update", "hermes-skills"],
  // Settings, System Update
  ["clawbox__preferences_get", "Settings Read", "settings"],
  ["clawbox__preferences_set", "Settings Update", "settings"],
  ["clawbox__ai_set_provider", "Settings Update", "settings"],
  ["clawbox__ai_set_model", "Settings Update", "settings"],
  ["clawbox__update_check", "System Update Check", "system_update"],
  // Features with no desktop app of their own
  ["cron", "Automations", "automations"],
  ["cronjob", "Automations", "automations"],
  ["cronjob_manage", "Automations", "automations"],
  ["image_generate", "Image Generation", "image-generation"],
  ["mcp__clawbox__generate_image", "Image Generation", "image-generation"],
];

describe("every box tool names its app", () => {
  it.each(TOOL_ROWS)("%s → %s", (wire, label, brand) => {
    expect(prettifyToolName(wire)).toBe(label);
    expect(toolBrand(wire)).toBe(brand);
  });

  it("covers every tool the table holds, so no mapping goes untested", () => {
    const tested = new Set(TOOL_ROWS.map(([wire]) => wire.replace(/^(?:[a-z0-9-]+__)+/i, "").replace(/^mcp_clawbox_/, "")));
    for (const def of Object.values(TOOL_STEP_APPS)) {
      for (const tool of [...Object.keys(def.tools ?? {}), ...Object.keys(def.boxTools ?? {})]) {
        expect(tested.has(tool), tool).toBe(true);
      }
    }
  });
});

// Shell steps: OpenClaw's `exec`, Claude Code's `Bash`, Hermes' `terminal`.
const COMMAND_ROWS: [command: string, label: string][] = [
  // Memory Shard
  ["openclaw memory search \"meeting notes\"", "Memory Shard Search"],
  ["openclaw memory search --query deployment --max-results 20", "Memory Shard Search"],
  ["openclaw memory status --deep --json", "Memory Shard Status"],
  ["openclaw memory index --force", "Memory Shard Index"],
  ["openclaw memory get notes.md", "Memory Shard Read"],
  ["openclaw memory promote --limit 10", "Memory Shard"],
  ["openclaw memory", "Memory Shard"],
  // Prime Radiant: every wiki subcommand the pinned OpenClaw has
  ["openclaw wiki status", "Prime Radiant Status"],
  ["openclaw wiki doctor", "Prime Radiant Checks"],
  ["openclaw wiki lint", "Prime Radiant Checks"],
  ["openclaw wiki search \"who should I ask about Teams?\" --mode route-question", "Prime Radiant Search"],
  ["openclaw wiki get entity.alpha --from 1 --lines 80", "Prime Radiant Page"],
  ["openclaw wiki apply synthesis \"Alpha Summary\" --body \"...\"", "Prime Radiant Update"],
  ["openclaw wiki ingest ./notes/alpha.md", "Prime Radiant Import"],
  ["openclaw wiki okf import ./bundles/ga4", "Prime Radiant Import"],
  ["openclaw wiki bridge import", "Prime Radiant Import"],
  ["openclaw wiki unsafe-local import", "Prime Radiant Import"],
  ["openclaw wiki chatgpt import --export ./chatgpt-export --dry-run", "Prime Radiant Import"],
  ["openclaw wiki init", "Prime Radiant"],
  ["openclaw wiki compile", "Prime Radiant"],
  ["openclaw wiki obsidian status", "Prime Radiant"],
  // Automations
  ["openclaw cron list", "Automations List"],
  ["openclaw cron status", "Automations Status"],
  ["openclaw cron add \"0 7 * * *\" \"Morning brief\"", "Automations Create"],
  ["openclaw automations create \"*/15 * * * *\" --message check", "Automations Create"],
  ["openclaw automations edit job-1 --message \"Updated prompt\"", "Automations Update"],
  ["openclaw cron rm job-1", "Automations Remove"],
  ["openclaw automations run job-1 --wait", "Automations Run"],
  ["openclaw automations runs job-1 --limit 20", "Automations List"],
  ["openclaw cron enable job-1", "Automations"],
  ["hermes cron list", "Automations List"],
  ["hermes cron create \"every 1h\" \"Check the feed\"", "Automations Create"],
  ["hermes cron remove job-1", "Automations Remove"],
  // Skills
  ["openclaw skills list", "Skills List"],
  ["openclaw skills search pdf", "Skills Search"],
  ["openclaw skills info weather", "Skills Read"],
  ["openclaw skills install weather", "Skills Install"],
  ["openclaw skills check", "Skills Check"],
  ["hermes skills install official/research/arxiv", "Skills Install"],
  ["hermes skills uninstall arxiv", "Skills Uninstall"],
  ["hermes skills inspect arxiv", "Skills Read"],
  // ClawKeep
  ["clawkeep snapshots", "ClawKeep List"],
  ["clawkeep restore \"$SNAPSHOT\"", "ClawKeep Restore"],
  ["clawkeep pair --server https://clawbox.com", "ClawKeep"],
  // How the command is reached: wrappers, paths, runners, pipes
  ["timeout 60 openclaw memory search foo 2>&1 | head -50", "Memory Shard Search"],
  ["timeout -k 5 30s openclaw wiki search alpha", "Prime Radiant Search"],
  ["env OPENCLAW_LOG_LEVEL=debug openclaw wiki search alpha", "Prime Radiant Search"],
  ["env -u NO_COLOR openclaw memory status", "Memory Shard Status"],
  ["NO_COLOR=1 openclaw memory status --json | jq .", "Memory Shard Status"],
  ["/usr/local/bin/openclaw wiki get entity.alpha", "Prime Radiant Page"],
  ["~/.npm-global/bin/openclaw memory index", "Memory Shard Index"],
  ["npx openclaw memory search foo", "Memory Shard Search"],
  ["npx -y openclaw@2026.10.3 wiki lint", "Prime Radiant Checks"],
  ["pnpm dlx openclaw wiki status", "Prime Radiant Status"],
  ["bunx openclaw memory status", "Memory Shard Status"],
  ["node /opt/openclaw/openclaw.mjs memory status", "Memory Shard Status"],
  ["sudo -u clawbox openclaw memory status", "Memory Shard Status"],
  ["nohup openclaw wiki compile > /tmp/compile.log 2>&1 &", "Prime Radiant"],
  ["openclaw --profile work memory search foo", "Memory Shard Search"],
  ["openclaw wiki --agent support search \"refund policy\"", "Prime Radiant Search"],
  ["cd /tmp && openclaw wiki status --json", "Prime Radiant Status"],
  ["export NO_COLOR=1; openclaw memory status", "Memory Shard Status"],
  ["bash -lc 'openclaw memory search \"x\" | head'", "Memory Shard Search"],
  ["sh -c \"openclaw wiki search alpha\"", "Prime Radiant Search"],
  ["openclaw memory search foo\nopenclaw memory status", "Memory Shard Search"],
];

describe("a shell step that runs a box CLI names its app", () => {
  it.each(COMMAND_ROWS)("%s → %s", (command, label) => {
    for (const shell of ["exec", "Bash", "bash", "terminal", "clawbox__bash"]) {
      expect(prettifyToolName(shell, command), shell).toBe(label);
      expect(toolBrand(shell, command), shell).not.toBeNull();
    }
  });

  it("reads the command out of a replayed call's argument summary", () => {
    // Hermes summarises a call with one string argument as the bare value, and
    // anything else as compact JSON cut at 160 characters.
    expect(prettifyToolName("terminal", "{\"command\":\"openclaw memory status\",\"timeout\":60}")).toBe("Memory Shard Status");
    expect(prettifyToolName("terminal", "{\"timeout\":60,\"command\":\"openclaw wiki search \\\"alpha beta\\\" --mode raw-claim --json | head -c 2000 and so on for a long whi")).toBe("Prime Radiant Search");
  });
});

describe("what is NOT a box app keeps its own name", () => {
  it.each([
    "echo \"openclaw memory search\"",
    "grep -r \"openclaw wiki\" docs/",
    "cat ~/.openclaw/memory/notes.md",
    "ls openclaw memory",
    "git commit -m \"openclaw memory search fix\"",
    "openclaw status",
    "openclaw gateway restart",
    "openclaw backup create",
    "openclaw",
    "openclaw-memory search x",
    "./openclaw.sh memory search x",
    "hermes memory setup",
    "hermes chat -q \"openclaw memory search\"",
    "# openclaw memory search",
    "python3 -c \"print('openclaw memory search')\"",
    "ls -la && echo done",
    "",
  ])("%j stays a shell step", (command) => {
    expect(prettifyToolName("exec", command)).toBe("exec");
    expect(toolBrand("exec", command)).toBeNull();
    expect(prettifyToolName("Bash", command)).toBe("Bash");
  });

  it("does not read a command into a tool that is not a shell", () => {
    expect(prettifyToolName("read", "openclaw memory search x")).toBe("read");
    expect(toolBrand("Write", "openclaw memory search x")).toBeNull();
    expect(toolBrand("web_search", "openclaw wiki search alpha")).toBeNull();
  });

  it.each([
    ["Grep", "Grep"],
    ["Read", "Read"],
    ["Write", "Write"],
    ["Edit", "Edit"],
    ["Glob", "Glob"],
    ["Bash", "Bash"],
    ["exec", "exec"],
    ["web_search", "web search"],
    // The harness's own tools of the same family are not the box's app.
    ["memory", "memory"],
    ["browser", "browser"],
    ["browser_navigate", "browser navigate"],
    ["browser_click", "browser click"],
    ["hermes__browser_snapshot", "browser snapshot"],
    // ClawBox's own generic tools: no app, but no server prefix either.
    ["clawbox__grep", "grep"],
    ["clawbox__read_file", "read file"],
    ["mcp__clawbox__system_stats", "system stats"],
    ["mcp_clawbox_system_stats", "system stats"],
    ["clawbox__describe_image", "describe image"],
    ["clawbox__email_send", "email send"],
    ["constructor", "constructor"],
    ["toString", "toString"],
  ])("%s → %s, no mark", (wire, label) => {
    expect(prettifyToolName(wire)).toBe(label);
    expect(toolBrand(wire)).toBeNull();
  });

  it("finds nothing under an object's own property names", () => {
    for (const wire of ["__proto__", "hasOwnProperty", "clawbox__constructor"]) expect(toolBrand(wire), wire).toBeNull();
    expect(toolBrand("exec", "openclaw memory constructor")).toBe("memory-shard");
    expect(prettifyToolName("exec", "openclaw memory constructor")).toBe("Memory Shard");
    expect(toolBrand("exec", "openclaw constructor search")).toBeNull();
  });
});

describe("the table speaks the desktop's language", () => {
  it("names an app with the key the desktop names it with, and the same English", () => {
    for (const [brand, def] of Object.entries(TOOL_STEP_APPS)) {
      if (!def.app) continue;
      const app = apps.find((a) => a.id === def.app);
      expect(app, brand).toBeDefined();
      expect(translations.en[app!.name] ?? app!.name, brand).toBe(def.english);
    }
  });

  it("draws an app's mark with the desktop's own glyph", () => {
    for (const [brand, def] of Object.entries(TOOL_STEP_APPS)) {
      if (!def.app || brand === "prime-radiant" || brand === "browser") continue;
      expect(APP_GLYPHS[def.app], brand).toBeTruthy();
    }
  });

  it("names a feature with no app by its own key, with a glyph the bundled font carries", () => {
    const font = readFileSync(path.join(process.cwd(), "public/fonts/material-symbols-rounded.ttf"), "latin1").split("\n");
    for (const [brand, def] of Object.entries(TOOL_STEP_APPS)) {
      if (def.app) continue;
      expect(def.nameKey, brand).toBeTruthy();
      expect(translations.en[def.nameKey!], brand).toBe(def.english);
      const word = new RegExp(`(^|[^A-Za-z0-9_])${def.glyph}([^A-Za-z0-9_]|$)`);
      expect(font.some((line) => word.test(line)), `${brand}: ${def.glyph}`).toBe(true);
    }
  });

  it("has every action word in the catalogue", () => {
    const actions = new Set<string>();
    for (const def of Object.values(TOOL_STEP_APPS)) {
      for (const action of [...Object.values(def.tools ?? {}), ...Object.values(def.boxTools ?? {})]) if (action) actions.add(action);
      for (const subcommands of Object.values(def.cli ?? {})) for (const action of Object.values(subcommands)) actions.add(action);
    }
    expect(actions.size).toBeGreaterThan(10);
    for (const action of actions) expect(translations.en[`chat.step.action.${action}`], action).toBeTruthy();
    expect(translations.en["chat.step.label"]).toBe("{app} {action}");
  });
});
