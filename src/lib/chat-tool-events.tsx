import { useCallback, useState } from "react";
import type { ChatToolSummary } from "@/lib/chat-history-cache";
import AgentBrowserIcon from "@/components/AgentBrowserIcon";
import PrimeRadiantIcon from "@/components/PrimeRadiantIcon";
import { chatStepEn } from "@/lib/chat-step-translations";
import { APP_GLYPHS, apps } from "@/lib/desktop-apps";
import { useTr } from "@/lib/i18n-floor";

// The OpenClaw gateway broadcasts tool-call lifecycle as `event: 'agent'`
// with `stream: 'tool'`; payload `data.phase` is `start | update | result`.

export interface ChatToolCall {
  id: string;
  name: string;
  /**
   * What the call was asked to do, when the event said — a shell step's
   * command line. It is what lets `exec` running `openclaw memory search`
   * read as the app it reached (`toolStep`).
   */
  detail?: string;
  /** The row's English label: what it is grouped by, and the floor it is drawn from. */
  prettyName: string;
  phase: "running" | "done";
  startedAt: number;
}

// An MCP server prefixes its tools with its own name: `server__tool`. Stripping
// it is what makes the readers below look at the TOOL, not the server it came
// from — without it a server called `image-gen` would make every one of its
// tools look like image generation. Stripped as often as it is there: Claude
// Code reaching OpenClaw's own tools through OpenClaw's MCP bridge names them
// `mcp__openclaw__memory_search`, and stripping only `mcp__` left a row that
// read "openclaw memory search".
const TOOL_SERVER_PREFIX_RE = /^[a-z0-9-]+__/i;

/** ClawBox's own MCP server, as every harness names it. */
const BOX_SERVER = "clawbox";

/**
 * How Hermes names an MCP server's tools: `mcp_<server>_<tool>`, joined by
 * single underscores. Server names may hold underscores too, so only the
 * box's own server is taken off — any other stays part of the tool's name.
 */
const HERMES_BOX_PREFIX = `mcp_${BOX_SERVER}_`;

// ---------------------------------------------------------------------------
// Which ClawBox app a step belongs to.
//
// ONE table, by app: the tools each app answers to and the CLI commands that
// reach the same app from a shell. A step row names the app the owner knows —
// "Memory Shard Search", not `memory_search`, `mcp__openclaw__memory_search`
// or `exec` running `openclaw memory search` — and draws the app's mark. A
// tool with no app (Grep, Read, a plain shell command, the box's generic file
// and web tools) keeps its own name.
// ---------------------------------------------------------------------------

/** The word after the app's name: "Search" in "Memory Shard Search". */
export type ToolAction =
  | "search" | "read" | "page" | "status" | "index" | "update" | "checks" | "check" | "import"
  | "list" | "create" | "remove" | "run" | "install" | "uninstall" | "backup" | "restore"
  | "start" | "stop" | "resume" | "message" | "open" | "close" | "click" | "type" | "scroll"
  | "screenshot" | "map" | "usage" | "settings" | "review" | "history" | "verify" | "undo";

/** A desktop app's id, or a feature that has no desktop app of its own. */
export type ToolBrand =
  | "memory-shard" | "prime-radiant" | "clawkeep" | "coding" | "browser" | "vnc" | "screenshot"
  | "store" | "hermes-skills" | "settings" | "system_update" | "automations" | "image-generation";

/** What a step does in its app. `null`: the app's name alone. */
type Actions = Readonly<Record<string, ToolAction | null>>;

export interface ToolStepApp {
  /** The desktop app (`desktop-apps.ts` id): its name key and its glyph are the desktop's own. */
  app?: string;
  /** A feature with no app: its own name key and glyph. */
  nameKey?: string;
  glyph?: string;
  /** The name in English — the floor before a dictionary has loaded, and the label `prettifyToolName` gives. */
  english: string;
  /** The mark's colour on the chat's dark row. */
  tint?: string;
  /** Tool name, server prefix taken off → what it does. From any server, or none. */
  tools?: Actions;
  /**
   * As `tools`, but only through ClawBox's own MCP server: the bare names
   * also belong to a harness built-in that is NOT this app — Hermes ships a
   * browser toolset of its own, driving a browser the owner cannot see.
   */
  boxTools?: Actions;
  /**
   * A CLI command group ("openclaw memory", or a whole program: "clawkeep")
   * → subcommand → what it does. Every other subcommand of a group listed
   * here is the app's name alone.
   */
  cli?: Readonly<Record<string, Readonly<Record<string, ToolAction>>>>;
}

const CRON_SUBCOMMANDS = {
  list: "list", status: "status", add: "create", create: "create", edit: "update",
  rm: "remove", remove: "remove", delete: "remove", run: "run", runs: "list", history: "list",
} as const;

const SKILLS_SUBCOMMANDS = {
  list: "list", search: "search", browse: "search", info: "read", inspect: "read", check: "check",
  install: "install", uninstall: "uninstall", update: "update",
} as const;

export const TOOL_STEP_APPS: Readonly<Record<ToolBrand, ToolStepApp>> = Object.freeze({
  // `memory_*` is OpenClaw's memory index, which is Memory Shard's;
  // `memory_shard_*` is ClawBox's own over the same index where there is no
  // OpenClaw (`src/lib/memory-index-local.ts`). Hermes' own `memory` tool is
  // its notes file, not this app.
  "memory-shard": {
    app: "memory-shard",
    english: "Memory Shard",
    tint: "#9fd3ff",
    tools: {
      memory_search: "search", memory_get: "read", memory_shard_search: "search", memory_shard_status: "status",
      memory_shard_reindex: "index", memory_shard_reindex_stop: "stop",
      memory_shard_sources_list: "list", memory_shard_sources_add: "create", memory_shard_sources_remove: "remove",
      memory_shard_schedule_get: "settings", memory_shard_schedule_set: "settings",
      memory_shard_provider_get: "settings", memory_shard_provider_set: "settings",
      memory_shard_enable: "settings", memory_shard_reset: "settings",
    },
    cli: { "openclaw memory": { search: "search", status: "status", index: "index", get: "read" } },
  },
  // OpenClaw's `wiki_*` tools read and write the Prime Radiant vault (the
  // `memory-wiki` plugin is pointed at it, `prime-radiant/plugin-wiring.ts`);
  // `prime_radiant_*` are ClawBox's own (`mcp/tools/prime-radiant.ts`), the
  // app's every action through its routes.
  "prime-radiant": {
    app: "prime-radiant",
    english: "Prime Radiant",
    tools: { wiki_status: "status", wiki_search: "search", wiki_get: "page", wiki_apply: "update", wiki_lint: "checks" },
    boxTools: {
      prime_radiant_status: "status", prime_radiant_pages: "list", prime_radiant_page: "page",
      prime_radiant_search: "search", prime_radiant_map: "map", prime_radiant_lint: "checks",
      prime_radiant_costs: "usage", prime_radiant_settings: "settings", prime_radiant_review_list: "review",
      prime_radiant_history: "history", prime_radiant_diff: "history", prime_radiant_ingest_status: "import",
      prime_radiant_page_create: "create", prime_radiant_page_edit: "update", prime_radiant_page_delete: "remove",
      prime_radiant_page_merge: "update", prime_radiant_pages_bulk_edit: "update",
      prime_radiant_claim_add: "create", prime_radiant_claim_edit: "update", prime_radiant_claim_delete: "remove",
      prime_radiant_claim_verify: "verify", prime_radiant_review_resolve: "review", prime_radiant_review_raise: "review",
      prime_radiant_undo: "undo", prime_radiant_ingest_preview: "import", prime_radiant_ingest_start: "import",
      prime_radiant_ingest_stop: "stop", prime_radiant_ingest_retry: "import", prime_radiant_nightly_run: "run",
      prime_radiant_nightly_merge: "update", prime_radiant_connect_run: "run", prime_radiant_settings_update: "settings",
    },
    cli: {
      "openclaw wiki": {
        status: "status", doctor: "checks", lint: "checks", search: "search", get: "page", apply: "update",
        ingest: "import", okf: "import", bridge: "import", "unsafe-local": "import", chatgpt: "import",
      },
    },
  },
  clawkeep: {
    app: "clawkeep",
    english: "ClawKeep",
    tint: "#86efac",
    tools: { backup_status: "status", backup_list: "list", backup_now: "backup" },
    cli: { clawkeep: { snapshots: "list", restore: "restore", delete: "remove", prune: "remove" } },
  },
  coding: {
    app: "coding",
    english: "Coding Agent",
    tint: "#93c5fd",
    tools: {
      coding_agent_run: "start", coding_agent_status: "status", coding_agent_stop: "stop", coding_agent_resume: "resume",
      coding_run_message: "message", coding_run_list: "list", coding_project_status: "status", coding_secret_list: "list",
      coding_team_run: "start", coding_team_status: "status", coding_team_stop: "stop", team_message: "message",
      anthropic_accounts: null,
    },
  },
  // The Chromium on the desktop that ClawBox's `browser_*` tools drive.
  browser: {
    app: "browser",
    english: "Agent Browser",
    tint: "#93c5fd",
    boxTools: {
      browser_open: "open", browser_navigate: "open", browser_view_local: "open", browser_screenshot: "screenshot",
      browser_close: "close", browser_click: "click", browser_type: "type", browser_fill: "type",
      browser_keypress: "type", browser_scroll: "scroll",
    },
  },
  vnc: { app: "vnc", english: "Remote Desktop", tint: "#c4b5fd", tools: { vnc_status: "status" } },
  screenshot: { app: "screenshot", english: "Screenshot", tint: "#fda4af", tools: { screen_capture: null } },
  store: {
    app: "store",
    english: "Store",
    tint: "#86efac",
    tools: { app_search: "search", app_install: "install", app_uninstall: "uninstall" },
  },
  // ClawBox's `skill_*` tools and Hermes' own `skills_list`/`skill_view`/
  // `skill_manage` both work the skills the Skills app shows.
  "hermes-skills": {
    app: "hermes-skills",
    english: "Skills",
    tint: "#d8b4fe",
    tools: {
      skill_search: "search", skill_list: "list", skill_info: "read", skill_install: "install", skill_uninstall: "uninstall",
      skills_list: "list", skill_view: "read", skill_manage: "update",
    },
    cli: { "openclaw skills": SKILLS_SUBCOMMANDS, "hermes skills": SKILLS_SUBCOMMANDS },
  },
  settings: {
    app: "settings",
    english: "Settings",
    tint: "#d1d5db",
    tools: { preferences_get: "read", preferences_set: "update", ai_set_provider: "update", ai_set_model: "update" },
  },
  system_update: { app: "system_update", english: "System Update", tint: "#7dd3fc", tools: { update_check: "check" } },
  // Scheduled jobs: OpenClaw's `cron` tool and CLI (`automations` is its
  // alias), Hermes' `cronjob` tool and `hermes cron`.
  automations: {
    nameKey: "chat.step.app.automations",
    glyph: "schedule",
    english: chatStepEn["chat.step.app.automations"],
    tint: "#fcd34d",
    tools: { cron: null, cronjob: null, cronjob_manage: null },
    cli: { "openclaw cron": CRON_SUBCOMMANDS, "openclaw automations": CRON_SUBCOMMANDS, "hermes cron": CRON_SUBCOMMANDS },
  },
  "image-generation": {
    nameKey: "chat.step.app.imageGeneration",
    glyph: "image",
    english: chatStepEn["chat.step.app.imageGeneration"],
    tint: "#f9a8d4",
    tools: { image_generate: null, generate_image: null },
  },
});

/** The desktop's own name for an app: an `app.*` key, or a product name that is its own key. */
function appNameKey(def: ToolStepApp): string {
  if (def.nameKey) return def.nameKey;
  return apps.find((a) => a.id === def.app)?.name ?? def.english;
}

interface ToolEntry { brand: ToolBrand; action: ToolAction | null; boxOnly: boolean }

// The table, turned around for lookup. Maps rather than objects, so a tool
// called `constructor` or `__proto__` finds nothing.
const TOOL_INDEX = new Map<string, ToolEntry>();
const CLI_INDEX = new Map<string, { brand: ToolBrand; subcommands: Readonly<Record<string, ToolAction>> }>();
for (const [brand, def] of Object.entries(TOOL_STEP_APPS) as [ToolBrand, ToolStepApp][]) {
  for (const [tool, action] of Object.entries(def.tools ?? {})) TOOL_INDEX.set(tool, { brand, action, boxOnly: false });
  for (const [tool, action] of Object.entries(def.boxTools ?? {})) TOOL_INDEX.set(tool, { brand, action, boxOnly: true });
  for (const [command, subcommands] of Object.entries(def.cli ?? {})) CLI_INDEX.set(command, { brand, subcommands });
}

/** A step that used a ClawBox app: which one, and what it did there. */
export interface ToolStep { brand: ToolBrand; action: ToolAction | null }

/** The tool a wire name names, and the servers it came through. */
function parseToolName(raw: string): { tool: string; servers: string[] } {
  let tool = raw.trim();
  const servers: string[] = [];
  for (let m = TOOL_SERVER_PREFIX_RE.exec(tool); m && m[0].length < tool.length; m = TOOL_SERVER_PREFIX_RE.exec(tool)) {
    servers.push(m[0].slice(0, -2).toLowerCase());
    tool = tool.slice(m[0].length);
  }
  if (tool.toLowerCase().startsWith(HERMES_BOX_PREFIX) && tool.length > HERMES_BOX_PREFIX.length) {
    servers.push(BOX_SERVER);
    tool = tool.slice(HERMES_BOX_PREFIX.length);
  }
  return { tool, servers };
}

/**
 * The tools that run a shell command: OpenClaw's `exec`, Claude Code's `Bash`
 * (and ClawBox's own `bash`), Hermes' `terminal`. Only these have a command
 * line worth reading — a `read` whose argument mentions the CLI read a file.
 */
const SHELL_TOOLS = new Set(["exec", "bash", "terminal", "shell"]);

/**
 * Which app a step used, if it used one.
 *
 * `raw` is the tool's name as the wire gives it; `detail` is what it was
 * asked to do, when known — the command line of a shell step, or a replayed
 * call's argument summary.
 */
export function toolStep(raw: string, detail?: string): ToolStep | null {
  if (!raw) return null;
  const { tool, servers } = parseToolName(raw);
  const key = tool.toLowerCase();
  const entry = TOOL_INDEX.get(key);
  if (entry && (!entry.boxOnly || servers.includes(BOX_SERVER))) return { brand: entry.brand, action: entry.action };
  if (detail && SHELL_TOOLS.has(key)) return cliStep(commandOf(detail), 0);
  return null;
}

/**
 * The command line out of a step's detail. Hermes replays a call with one
 * string argument as that string, and anything else as compact JSON cut at
 * 160 characters — so the `command` field is read even off a cut-off object.
 */
function commandOf(detail: string): string {
  const text = detail.trim();
  if (!text.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    const command = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).command : undefined;
    return typeof command === "string" ? command : "";
  } catch {
    const cut = /"(?:command|cmd)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
    if (!cut) return "";
    try { return JSON.parse(`"${cut[1]}"`) as string; } catch { return cut[1]; }
  }
}

/**
 * A shell line, split into the commands it runs (`;`, `&&`, `||`, `|`, `&`
 * and newlines), each as its words with the quoting taken off. `2>&1` and
 * `&>` are redirections, not separators; a `#` that starts a word comments
 * out the rest of its line.
 */
function shellCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === "\"" && i + 1 < line.length) word += line[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === "\"") {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (c === "#" && !inWord) {
      while (i + 1 < line.length && line[i + 1] !== "\n") i++;
    } else if (c === "&" && (line[i - 1] === ">" || line[i + 1] === ">")) {
      word += c;
      inWord = true;
    } else if (c === ";" || c === "|" || c === "&" || c === "\n") {
      endCommand();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** Commands that only set the stage for the next one: `cd dir && openclaw …`. */
const SETUP_COMMANDS = new Set(["cd", "pushd", "export", "source", ".", "set", "unset", "umask"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** The last path segment, so `/usr/local/bin/openclaw` is `openclaw`. */
function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** Past the flags at `i`; `withValue` names the flags whose value is the next word. */
function skipFlags(words: readonly string[], i: number, withValue: ReadonlySet<string> = new Set()): number {
  while (i < words.length && words[i].startsWith("-") && words[i] !== "-" && words[i] !== "--") {
    i += withValue.has(words[i]) ? 2 : 1;
  }
  return words[i] === "--" ? i + 1 : i;
}

const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const TIMEOUT_VALUE_FLAGS = new Set(["-k", "--kill-after", "-s", "--signal"]);
const SUDO_VALUE_FLAGS = new Set(["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user"]);
const NICE_VALUE_FLAGS = new Set(["-n", "--adjustment", "-c", "--class", "-p", "--pid", "-i", "-o", "-e"]);
const NPX_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);
/** Global and group options of the CLIs below that take a value, so it is not read as the subcommand. */
const CLI_VALUE_FLAGS = new Set(["--profile", "-p", "--log-level", "--container", "--agent"]);

/**
 * The program a command runs and its arguments, past what only wraps it:
 * `VAR=x`, `env`, `timeout 60`, `sudo -u clawbox`, `nice`, `nohup`, and the
 * package runners (`npx -y openclaw@2026.10.3`, `pnpm dlx`, `bunx`, or
 * `node …/openclaw.mjs`). The program comes back as its bare name, a version
 * pin or a script's extension taken off.
 */
function unwrap(words: readonly string[]): { program: string; args: readonly string[] } | null {
  let i = 0;
  for (;;) {
    while (i < words.length && ASSIGNMENT_RE.test(words[i])) i++;
    if (i >= words.length) return null;
    const head = basename(words[i]);
    if (head === "env") i = skipFlags(words, i + 1, ENV_VALUE_FLAGS);
    else if (head === "timeout") i = skipFlags(words, i + 1, TIMEOUT_VALUE_FLAGS) + 1;
    else if (head === "sudo") i = skipFlags(words, i + 1, SUDO_VALUE_FLAGS);
    else if (head === "nice" || head === "ionice" || head === "stdbuf") i = skipFlags(words, i + 1, NICE_VALUE_FLAGS);
    else if (head === "nohup" || head === "command" || head === "exec" || head === "time") i = skipFlags(words, i + 1);
    else if (head === "npx" || head === "bunx" || head === "pnpx") i = skipFlags(words, i + 1, NPX_VALUE_FLAGS);
    else if ((head === "pnpm" || head === "yarn" || head === "npm" || head === "bun") && ["dlx", "exec", "x"].includes(words[i + 1] ?? "")) {
      i = skipFlags(words, i + 2, NPX_VALUE_FLAGS);
    } else if ((head === "node" || head === "bun") && /^openclaw\.(?:m|c)?js$/.test(basename(words[skipFlags(words, i + 1)] ?? ""))) {
      return { program: "openclaw", args: words.slice(skipFlags(words, i + 1) + 1) };
    } else {
      // `openclaw@2026.10.3` is what npx is handed; the program is `openclaw`.
      return { program: head.replace(/@[^/]*$/, ""), args: words.slice(i + 1) };
    }
  }
}

/** The first `count` words of `args` that are not options (nor an option's value). */
function positionals(args: readonly string[], count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length && out.length < count; i++) {
    const word = args[i];
    if (word.startsWith("-")) {
      if (CLI_VALUE_FLAGS.has(word)) i++;
      continue;
    }
    out.push(word);
  }
  return out;
}

/**
 * Which app a shell line reaches, judged by the command it RUNS — not by the
 * words it mentions. Commands that only set the stage (`cd`, `export`, an
 * assignment) are passed over; the first one that does something decides,
 * and whatever it is piped into (`| head`, `2>&1 | jq`) does not change it.
 * `bash -lc '…'` is read once more inside.
 */
function cliStep(line: string, depth: number): ToolStep | null {
  for (const words of shellCommands(line)) {
    if (words.every((w) => ASSIGNMENT_RE.test(w)) || SETUP_COMMANDS.has(words[0])) continue;
    const run = unwrap(words);
    if (!run) return null;
    if (SHELLS.has(run.program)) {
      const flag = run.args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      return flag !== -1 && depth < 2 && run.args[flag + 1] ? cliStep(run.args[flag + 1], depth + 1) : null;
    }
    // A group of a program (`openclaw memory search`), or a program that is
    // one app throughout (`clawkeep restore`).
    const [first, second] = positionals(run.args, 2);
    const group = first !== undefined ? CLI_INDEX.get(`${run.program} ${first}`) : undefined;
    const match = group ?? CLI_INDEX.get(run.program);
    if (!match) return null;
    const sub = group ? second : first;
    const action = sub !== undefined && Object.prototype.hasOwnProperty.call(match.subcommands, sub) ? match.subcommands[sub] : null;
    return { brand: match.brand, action };
  }
  return null;
}

/** `t`, or the English floor: what a step's label is put together with. */
type Translate = (key: string, english: string, params?: Record<string, string | number>) => string;

const englishFloor: Translate = (_key, english, params) =>
  Object.entries(params ?? {}).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), english);

function stepLabel(step: ToolStep, tr: Translate): string {
  const def = TOOL_STEP_APPS[step.brand];
  const app = tr(appNameKey(def), def.english);
  if (!step.action) return app;
  const action = tr(`chat.step.action.${step.action}`, chatStepEn[`chat.step.action.${step.action}`]);
  return tr("chat.step.label", chatStepEn["chat.step.label"], { app, action });
}

/** Which app's mark a tool's step row carries, if any. */
export function toolBrand(raw: string, detail?: string): ToolBrand | null {
  return toolStep(raw, detail)?.brand ?? null;
}

/** A tool's name with its server prefix taken off and its underscores turned into spaces. */
function plainToolName(raw: string): string {
  const cleaned = parseToolName(raw).tool.replace(/[_]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : raw;
}

/** A step row's label, in English: its app's, or the tool's own name. */
export function prettifyToolName(raw: string, detail?: string): string {
  if (!raw) return "tool";
  const step = toolStep(raw, detail);
  return step ? stepLabel(step, englishFloor) : plainToolName(raw);
}

/** `prettifyToolName` in the owner's language — what a row actually shows. */
export function useToolStepLabel(): (raw: string, detail?: string) => string {
  const tr = useTr();
  return useCallback(
    (raw: string, detail?: string) => {
      if (!raw) return "tool";
      const step = toolStep(raw, detail);
      return step ? stepLabel(step, tr) : plainToolName(raw);
    },
    [tr],
  );
}

/**
 * What a tool event says the call was asked to do. The harness adapter hands
 * it over as `detail` (Hermes' `tool.start` context); the gateway's own
 * stream carries the call's `args` — `command` for a shell step — or a
 * one-line `meta`.
 */
function eventDetail(data: Record<string, unknown>): string | undefined {
  if (typeof data.detail === "string" && data.detail) return data.detail;
  const args = data.args;
  if (args && typeof args === "object") {
    const command = (args as Record<string, unknown>).command ?? (args as Record<string, unknown>).cmd;
    if (typeof command === "string" && command) return command;
    if (Array.isArray(command) && command.length > 0 && command.every((w) => typeof w === "string")) return command.join(" ");
  }
  return typeof data.meta === "string" && data.meta ? data.meta : undefined;
}

/**
 * True if `raw` names the harness' image-generation tool.
 *
 * Matched loosely (both words, either order, with or without a server prefix)
 * because the name reaches us straight off the wire: `image_generate` today,
 * but `mcp__x__generate_image` or `image_generation` are the same event as far
 * as the chat is concerned.
 */
export function isImageGenerationTool(raw: string): boolean {
  const name = raw.replace(TOOL_SERVER_PREFIX_RE, "").toLowerCase();
  return name.includes("image") && name.includes("gen");
}

export function useChatToolCalls(): {
  toolCalls: ChatToolCall[];
  applyToolEvent: (data: Record<string, unknown> | undefined) => void;
  clearToolCalls: () => void;
} {
  const [toolCalls, setToolCalls] = useState<ChatToolCall[]>([]);

  const applyToolEvent = useCallback((data: Record<string, unknown> | undefined) => {
    if (!data) return;
    const id = typeof data.toolCallId === "string" ? data.toolCallId : "";
    if (!id) return;
    const name = typeof data.name === "string" && data.name.length > 0 ? data.name : "tool";
    const phase = typeof data.phase === "string" ? data.phase : "";
    // Read off a start or an update only. A result's own text is the call's
    // OUTPUT (Hermes hands its summary over as `detail`), and output that
    // happens to begin "openclaw memory …" did not run that command.
    const detail = phase === "result" ? undefined : eventDetail(data);
    setToolCalls((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (phase === "start") {
        if (idx === -1) {
          return [
            ...prev,
            { id, name, ...(detail ? { detail } : {}), prettyName: prettifyToolName(name, detail), phase: "running", startedAt: Date.now() },
          ];
        }
        const cur = prev[idx];
        const nextDetail = detail ?? cur.detail;
        if (cur.name === name && cur.detail === nextDetail && cur.phase === "running") return prev;
        const next = prev.slice();
        next[idx] = { ...cur, name, detail: nextDetail, prettyName: prettifyToolName(name, nextDetail), phase: "running" };
        return next;
      }
      if (phase === "result") {
        if (idx === -1 || prev[idx].phase === "done") return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], phase: "done" };
        return next;
      }
      if (phase === "update" && idx !== -1) {
        const cur = prev[idx];
        const nextDetail = detail ?? cur.detail;
        if (cur.name === name && cur.detail === nextDetail) return prev;
        const next = prev.slice();
        next[idx] = { ...cur, name, detail: nextDetail, prettyName: prettifyToolName(name, nextDetail) };
        return next;
      }
      return prev;
    });
  }, []);

  const clearToolCalls = useCallback(() => {
    setToolCalls((prev) => (prev.length === 0 ? prev : []));
  }, []);

  return { toolCalls, applyToolEvent, clearToolCalls };
}

// ---------------------------------------------------------------------------
// Rendering. Restyled after the Claude Code web UI: while a turn runs, each
// step is a quiet text row rather than a colored pill; once the turn is done,
// the whole step record collapses behind one "Ran N commands" line. The three
// tones survive the restyle — "it ran", "it is running" and "it went wrong"
// must stay one glance apart — they just moved from pill backgrounds onto the
// glyph and the text itself.
// ---------------------------------------------------------------------------

const ROW_FG_RUNNING = "#fdba74";
const ROW_FG_DONE = "rgba(255,255,255,0.45)";
// The palette the chat already uses for an error banner — so "it ran" and
// "it went wrong" stay one glance apart.
const ROW_FG_FAILED = "#fca5a5";

type ChipTone = "running" | "done" | "failed";

const ROW_FG: Record<ChipTone, string> = {
  running: ROW_FG_RUNNING,
  done: ROW_FG_DONE,
  failed: ROW_FG_FAILED,
};

const CHIP_GLYPH: Record<ChipTone, string> = { running: "🔧", done: "✓", failed: "!" };

/**
 * The app's mark beside its step: the desktop icon's own drawing — the two
 * pieces of vector art, and otherwise the app's glyph from `APP_GLYPHS`.
 */
function BrandMark({ brand }: { brand: ToolBrand }) {
  if (brand === "prime-radiant") {
    return <PrimeRadiantIcon className="w-3.5 h-3.5 shrink-0" />;
  }
  const def = TOOL_STEP_APPS[brand];
  if (brand === "browser") {
    return (
      <span style={{ display: "inline-flex", color: def.tint, flexShrink: 0 }}>
        <AgentBrowserIcon className="w-3.5 h-3.5" />
      </span>
    );
  }
  const glyph = def.app ? APP_GLYPHS[def.app] : def.glyph;
  if (!glyph) return null;
  return (
    <span
      aria-hidden="true"
      className="material-symbols-rounded"
      data-testid={`${brand}-mark`}
      style={{ fontSize: 14, lineHeight: 1, color: def.tint, flexShrink: 0 }}
    >
      {glyph}
    </span>
  );
}

/**
 * One step row.
 *
 * Extracted so the LIVE row and the REPLAYED row are the same element rather
 * than two that merely look alike today: a turn must not change appearance the
 * moment the page is refreshed, and the only way to guarantee that is to render
 * both from here.
 */
function ToolChip(
  { tone, label, suffix, title, brand }: { tone: ChipTone; label: string; suffix?: string; title?: string; brand?: ToolBrand | null },
) {
  return (
    <div
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "1px 2px",
        color: ROW_FG[tone],
        fontSize: 12,
        fontWeight: 500,
        maxWidth: "100%",
      }}
    >
      <span aria-hidden="true" style={{ width: 14, textAlign: "center", flexShrink: 0 }}>{CHIP_GLYPH[tone]}</span>
      {brand ? <BrandMark brand={brand} /> : null}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {suffix ? <span style={{ opacity: 0.7, flexShrink: 0 }}>· {suffix}</span> : null}
    </div>
  );
}

/**
 * Collapse CONSECUTIVE runs of the same-looking chip into one group — seven
 * `gateway` calls in a row render as one `gateway (7)` chip, not a column of
 * seven identical pills. Only adjacent repeats collapse: a different tool
 * between two `gateway` calls keeps them apart, so the row still reads as the
 * order the steps ran in. Keyed on what the chip DISPLAYS (pretty name, and
 * for summaries the tone too), because two entries that render identically
 * are the ones that read as duplication.
 */
export function groupConsecutiveBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && key(last[0]) === key(item)) last.push(item);
    else groups.push([item]);
  }
  return groups;
}

function countedLabel(label: string, count: number): string {
  return count > 1 ? `${label} (${count})` : label;
}

export function ToolCallPills({ toolCalls, runningLabel }: { toolCalls: ChatToolCall[]; runningLabel: string }) {
  const stepLabelFor = useToolStepLabel();
  if (toolCalls.length === 0) return null;
  // Grouped by the English label, drawn in the owner's language: the two are
  // the same function of the call, so what groups is what reads alike.
  const groups = groupConsecutiveBy(toolCalls, (tc) => tc.prettyName);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start" }}>
      {groups.map((group) => {
        // The running call is always the group's newest member; a group with
        // one still in flight shows as running so the count keeps ticking up
        // on the same pill instead of spawning a second one.
        const running = group.some((tc) => tc.phase !== "done");
        return (
          <ToolChip
            // First member's id: stable while the group grows.
            key={group[0].id}
            tone={running ? "running" : "done"}
            label={countedLabel(stepLabelFor(group[0].name, group[0].detail), group.length)}
            brand={toolBrand(group[0].name, group[0].detail)}
            {...(running ? { suffix: runningLabel } : {})}
          />
        );
      })}
    </div>
  );
}

/**
 * The steps a FINISHED turn took, as stored on the message.
 *
 * The live pills are cleared the moment a turn ends, so before this the only
 * record that the agent had run a browser or a shell was a sentence in the
 * reply. These persist — they come back with the transcript on a refresh, which
 * is the whole difference between an indicator and a record.
 *
 * Collapsed to one "Ran N commands" line by default: the record matters, the
 * screen space does not. It opens itself when any step FAILED — a failure is
 * not something to fold away — and the argument summary rides on `title`
 * rather than in the row, because it is model-authored text of unpredictable
 * length.
 */
export function ToolCallSummaryChips(
  { toolCalls, label, ranLabel }: {
    toolCalls: ChatToolSummary[];
    /** Accessible name for the whole record. */
    label: string;
    /** The collapsed line, already counted — e.g. "Ran 4 commands". */
    ranLabel?: string;
  },
) {
  // A failed step must be visible without a click.
  const [open, setOpen] = useState(() => (toolCalls ?? []).some((c) => c.status === "error"));
  const stepLabelFor = useToolStepLabel();
  if (!toolCalls || toolCalls.length === 0) return null;
  const anyFailed = toolCalls.some((c) => c.status === "error");
  return (
    <div data-testid="chat-tool-summary" aria-label={label} style={{ marginTop: 8 }}>
      <button
        type="button"
        data-testid="chat-tool-summary-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          background: "none",
          border: 0,
          padding: "2px 4px",
          marginLeft: -4,
          borderRadius: 6,
          cursor: "pointer",
          font: "inherit",
          fontSize: 12,
          fontWeight: 500,
          color: anyFailed ? ROW_FG_FAILED : "rgba(255,255,255,0.5)",
        }}
      >
        <span>{ranLabel ?? countedLabel(label, toolCalls.length)}</span>
        <span
          aria-hidden="true"
          className="material-symbols-rounded"
          style={{
            fontSize: 14,
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform 120ms ease",
          }}
        >
          chevron_right
        </span>
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start", marginTop: 2 }}>
          {groupConsecutiveBy(
            toolCalls,
            // Tone is part of the key: a failed call must never disappear into a
            // collapsed run of successes.
            (call) => `${prettifyToolName(call.name, call.detail)} ${call.status === "error" ? "error" : "ok"}`,
          ).map((group, index) => (
            <ToolChip
              key={`${group[0].name}-${index}`}
              tone={group[0].status === "error" ? "failed" : "done"}
              label={countedLabel(stepLabelFor(group[0].name, group[0].detail), group.length)}
              brand={toolBrand(group[0].name, group[0].detail)}
              // Every collapsed call keeps its argument summary — one per line.
              title={group.map((call) => (call.detail ? `${call.name}: ${call.detail}` : call.name)).join("\n")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
