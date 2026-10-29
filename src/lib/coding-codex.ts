/**
 * THE CODEX RUNNER — what an `openai` coding run hands the Codex CLI, and how
 * the box reads what the CLI says back.
 *
 * Every other provider runs on Claude Code through the `claude-ds` wrapper. An
 * `openai` run cannot: Claude Code speaks only the Anthropic API. So it runs
 * on OpenAI's own coding CLI, `codex exec`, non-interactively:
 *
 *  - `--json`, so stdout is one JSON event per line, into the same per-run
 *    stream log the Claude runs write (coding-agent.ts, STREAM_DIR) and read by
 *    the same tail — only the event handler differs (`codexEventActions`);
 *  - the task on stdin (`-`), as for Claude Code, so it never sits in argv;
 *  - `approval_policy="never"` and `sandbox_mode="danger-full-access"`: an
 *    unattended run has nobody to approve anything, and the box already fences
 *    the process exactly as it fences a Claude run (setpriv's capability drop,
 *    the run's own systemd scope). Codex's own Linux sandbox is bubblewrap in a
 *    user namespace, which this device class refuses (measured:
 *    `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`), so the
 *    `workspace-write` sandbox would fail every command a run tried. Claude
 *    runs get `Bash(*)` for the same reason: full access is about commands;
 *  - config as `-c key=value` rather than flags wherever both exist, because
 *    `codex exec resume` takes neither `--sandbox` nor `--cd` and an unknown
 *    `-c` key is ignored where an unknown flag would end the run.
 *
 * PURE ON PURPOSE — no fs, no child_process — so the argv and the event reading
 * are pinned by plain unit tests (coding-codex.test.ts). The spawn, the stream
 * and the settle stay in coding-agent.ts, beside the Claude path they mirror.
 */

import { OPENAI_MODELS, type OpenAIModel } from "@/lib/coding-provider";

/** The binary, relative to the home directory: where install.sh's `ensure_codex_cli` puts the pinned build. */
export const CODEX_BINARY_PATH = ".local/bin/codex";
export const CODEX_COMMAND = "codex";

/**
 * The folder under DATA_DIR that is the coding agent's CODEX_HOME.
 *
 * The box's OWN, never `~/.codex`: that one belongs to the gateway's ChatGPT
 * runtime, which mirrors an access token into it (scripts/codex-auth-mirror.js)
 * and must stay the only holder of that sign-in's refresh token. A coding run's
 * Codex keeps its login, its sessions and its rules here, and a ChatGPT
 * sign-in made for coding runs is a separate grant with its own token family —
 * so neither side can ever rotate the other's token out from under it.
 */
export const CODEX_HOME_DIR = "coding-agent-codex";

/** Codex's reasoning efforts, lowest first. */
export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/**
 * The reasoning efforts each offered model accepts, from the CLI's own catalogue
 * (`codex debug models`, `supported_reasoning_levels`, codex-cli 0.154.0).
 */
export const CODEX_MODEL_EFFORTS: Readonly<Record<OpenAIModel, readonly CodexReasoningEffort[]>> = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.2": ["low", "medium", "high", "xhigh"],
};

/** What every offered model accepts: the ceiling for an id this build does not know. */
const COMMON_EFFORTS: readonly CodexReasoningEffort[] = ["low", "medium", "high", "xhigh"];

function isOpenAIModel(model: string): model is OpenAIModel {
  return (OPENAI_MODELS as readonly string[]).includes(model);
}

/**
 * The box's effort level as Codex's reasoning effort for this model.
 *
 * The four fixed levels and `max` carry the same name on both CLIs and pass
 * through, lowered to the most the model accepts: asking a model for an effort
 * it does not offer is a refused request, not a softer one. `ultracode` is Claude
 * Code's orchestration mode ON TOP OF xhigh (EFFORT_LEVELS in coding-agent.ts):
 * Codex has no Workflow tool for its fan-out half, so what is left is its
 * thinking level, xhigh — never Codex's own `ultra`, which no Claude run's
 * level reaches. Anything unrecognised reads as the box's default, xhigh.
 */
export function codexReasoningEffort(effort: string, model: string | null): CodexReasoningEffort {
  const allowed = model && isOpenAIModel(model) ? CODEX_MODEL_EFFORTS[model] : COMMON_EFFORTS;
  const level = effort === "ultracode" ? "xhigh" : effort;
  // Only the box's own levels: `ultra` is Codex's word, and no box setting names it.
  const wanted = (CODEX_REASONING_EFFORTS as readonly string[]).includes(level) && level !== "ultra" ? (level as CodexReasoningEffort) : "xhigh";
  if (allowed.includes(wanted)) return wanted;
  // Lower, never higher: a level the model lacks is answered with the nearest
  // one beneath it, so a run never thinks harder (and costs more) than asked.
  const rank = CODEX_REASONING_EFFORTS.indexOf(wanted);
  for (let i = rank; i >= 0; i -= 1) if (allowed.includes(CODEX_REASONING_EFFORTS[i])) return CODEX_REASONING_EFFORTS[i];
  return allowed[0];
}

/**
 * A string as a TOML basic string — the form `-c key=value` parses its value in.
 *
 * JSON's escaping is TOML's for everything JSON.stringify emits, with two
 * exceptions handled here: DEL, which TOML forbids raw and JSON leaves alone,
 * and a lone surrogate, which JSON escapes as `\udXXX` and TOML refuses as a
 * non-scalar escape. A value TOML could not parse would not fail loudly — the CLI
 * takes an unparseable value as a raw literal — so the brief would arrive
 * wrapped in quote marks instead.
 */
export function tomlString(value: string): string {
  const scalar = value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  return JSON.stringify(scalar).replace(/\u007f/g, "\\u007F");
}

/** One MCP server as `codex -c mcp_servers.<name>=…` takes it. */
export interface CodexMcpServer {
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** A bare TOML key, or the key quoted. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** An MCP server entry as a TOML inline table. */
export function tomlMcpServer(server: CodexMcpServer): string {
  const parts = [
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
  ];
  const env = Object.entries(server.env ?? {});
  if (env.length > 0) parts.push(`env = { ${env.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(", ")} }`);
  return `{ ${parts.join(", ")} }`;
}

/**
 * The environment variable `codex exec` authenticates with when the owner
 * saved an API key — and the one variable a run's own commands must never
 * inherit (`shell_environment_policy.exclude` below).
 */
export const CODEX_API_KEY_ENV = "CODEX_API_KEY";

export interface CodexArgsOptions {
  /** The run's model, frozen on its record. */
  model: string;
  /** The box's effort level (CodingEffort); mapped by `codexReasoningEffort`. */
  effort: string;
  /** The device's brief, run notes and lessons — Claude Code's `--append-system-prompt`. */
  developerInstructions: string;
  /** The Codex thread to continue, or null for a fresh one. */
  resumeSessionId?: string | null;
  /** The MCP servers the run holds, by name. None of them may carry a secret: this is argv. */
  mcpServers?: Readonly<Record<string, CodexMcpServer>> | null;
  /**
   * A run that may only read — a team's planner. Claude Code is held to that by
   * its tool list; Codex has one shell for everything, so the only fence that
   * holds is its own `read-only` sandbox. Where the box cannot give Codex that
   * sandbox (no user namespaces) its commands fail rather than run unfenced:
   * a read-only run that cannot read is a failed run, one that can write is a
   * broken promise.
   */
  readOnly?: boolean;
}

/** The `-c` overrides every Codex run is started with, in order. Exported for the contract test. */
export function codexConfigOverrides(opts: CodexArgsOptions): string[] {
  const overrides = [
    // Nobody is there to approve anything, and the box's own fence is the
    // sandbox (see the header). Both again on a resume, which has no flags for them.
    `approval_policy="never"`,
    opts.readOnly ? `sandbox_mode="read-only"` : `sandbox_mode="danger-full-access"`,
    `model_reasoning_effort="${codexReasoningEffort(opts.effort, opts.model)}"`,
    // A run's commands see the environment a Claude run's Bash sees — the
    // owner's injected secrets included, which Codex would otherwise filter by
    // name (anything with KEY, TOKEN or SECRET in it) — except the run's own
    // API key, which is the CLI's to spend and nobody else's.
    `shell_environment_policy.inherit="all"`,
    `shell_environment_policy.ignore_default_excludes=true`,
    `shell_environment_policy.exclude=["${CODEX_API_KEY_ENV}"]`,
    // The appliance may be offline; a run that stalls on a version check
    // looks hung (the twin of CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).
    `check_for_update_on_startup=false`,
    `developer_instructions=${tomlString(opts.developerInstructions)}`,
  ];
  for (const [name, server] of Object.entries(opts.mcpServers ?? {})) {
    overrides.push(`mcp_servers.${tomlKey(name)}=${tomlMcpServer(server)}`);
  }
  return overrides;
}

/**
 * The argv after the `codex` binary. The prompt is `-`: read from stdin, where
 * the spawn writes the task and then closes the pipe.
 */
export function buildCodexArgs(opts: CodexArgsOptions): string[] {
  const args = opts.resumeSessionId ? ["exec", "resume"] : ["exec"];
  args.push("--json", "--skip-git-repo-check");
  for (const override of codexConfigOverrides(opts)) args.push("-c", override);
  // Named on a resume too: a session continued on another model is answered by
  // that model, and the CLI only warns about it.
  args.push("-m", opts.model);
  if (opts.resumeSessionId) args.push(opts.resumeSessionId);
  args.push("-");
  return args;
}

/**
 * The run's command fence as Codex execpolicy rules
 * (`$CODEX_HOME/rules/clawbox.rules`), from the same deny-list a Claude run is
 * started with — `Bash(<prefix>:*)` entries, each one a forbidden prefix. Kept
 * one list so the two runners cannot drift. Like Claude Code's prefix rules,
 * this is the first fence and not the only one: it matches the command a run
 * executes, not a command buried inside `bash -c`.
 */
export function codexRulesText(denylist: readonly string[], justification: string): string {
  const lines = ["# Written by ClawBox for its coding runs; replaced at every spawn."];
  for (const rule of denylist) {
    const m = /^Bash\((.+):\*\)$/.exec(rule);
    if (!m) continue;
    const words = m[1].split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    lines.push(`prefix_rule(pattern = [${words.map((w) => JSON.stringify(w)).join(", ")}], decision = "forbidden", justification = ${JSON.stringify(justification)})`);
  }
  return `${lines.join("\n")}\n`;
}

// ─── Reading the stream ─────────────────────────────────────────────────────

/** One thing a Codex event tells the box, in the box's own terms. */
export type CodexAction =
  | { kind: "session"; id: string }
  | { kind: "message"; text: string }
  | { kind: "reasoning" }
  | { kind: "command"; command: string }
  | { kind: "files"; paths: string[] }
  | { kind: "tool"; label: string }
  | { kind: "todos"; items: { text: string; completed: boolean }[] }
  | { kind: "usage"; input: number; cachedInput: number; output: number }
  | { kind: "completed" }
  | { kind: "failed"; error: string }
  | { kind: "notice"; text: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

const SHELL_RE = /^(?:\/\S*\/)?(?:ba|z)?sh$/;

/**
 * A command as the CLI reports it — a string, or an argv array on older builds
 * — with the `bash -lc "…"` Codex wraps every command in taken off, so the feed
 * and the side-effect check both read the command the run actually ran.
 */
export function codexCommandText(value: unknown): string | null {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    const argv = value as string[];
    if (argv.length === 3 && SHELL_RE.test(argv[0]) && (argv[1] === "-lc" || argv[1] === "-c")) return argv[2].trim() || null;
    return argv.join(" ").trim() || null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  // Quoted when the script has spaces (`bash -lc 'npm test'`), bare when it is one word (`bash -lc ls`).
  const quoted = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text);
  if (quoted) return quoted[2].trim() || null;
  const bare = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(\S+)$/.exec(text);
  return (bare ? bare[1] : text) || null;
}

function itemActions(phase: string, item: Record<string, unknown>): CodexAction[] {
  switch (item.type) {
    case "agent_message": {
      const text = phase === "item.completed" ? str(item.text) : null;
      return text ? [{ kind: "message", text: text.trim() }] : [];
    }
    case "reasoning":
      return [{ kind: "reasoning" }];
    case "command_execution": {
      // Once, when it starts: the completion repeats the command with its output.
      const command = phase === "item.started" ? codexCommandText(item.command) : null;
      return command ? [{ kind: "command", command }] : [];
    }
    case "file_change": {
      // A change is only real once the CLI says it was applied.
      if (phase !== "item.completed" || item.status !== "completed" || !Array.isArray(item.changes)) return [];
      const paths = item.changes
        .map((c) => (c && typeof c === "object" ? str((c as Record<string, unknown>).path) : null))
        .filter((p): p is string => p !== null);
      return paths.length > 0 ? [{ kind: "files", paths }] : [];
    }
    case "mcp_tool_call": {
      if (phase !== "item.started") return [];
      const server = str(item.server);
      const tool = str(item.tool);
      return tool ? [{ kind: "tool", label: server ? `${server}.${tool}` : tool }] : [];
    }
    case "web_search": {
      // On its completion only: that is where the query is filled in.
      if (phase !== "item.completed") return [];
      const query = str(item.query);
      return [{ kind: "tool", label: query ? `Web search: ${query.trim()}` : "Web search" }];
    }
    case "todo_list": {
      if (!Array.isArray(item.items)) return [];
      const items = item.items
        .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
        .map((t) => ({ text: str(t.text)?.trim() ?? "", completed: t.completed === true }))
        .filter((t) => t.text !== "");
      return items.length > 0 ? [{ kind: "todos", items }] : [];
    }
    case "error": {
      const text = phase === "item.completed" ? str(item.message) : null;
      return text ? [{ kind: "notice", text: text.trim() }] : [];
    }
    default:
      return [];
  }
}

/**
 * What one line of `codex exec --json` means, as actions for the run record.
 *
 * Tolerant by design: an event this build does not know is no action at all,
 * never a failure — the CLI adds event and item types between releases, and a
 * run must not die because it reported something new.
 */
export function codexEventActions(event: unknown): CodexAction[] {
  if (!event || typeof event !== "object") return [];
  const e = event as Record<string, unknown>;
  switch (e.type) {
    case "thread.started": {
      const id = str(e.thread_id);
      return id ? [{ kind: "session", id }] : [];
    }
    case "item.started":
    case "item.updated":
    case "item.completed":
      return e.item && typeof e.item === "object" ? itemActions(e.type, e.item as Record<string, unknown>) : [];
    case "turn.completed": {
      const usage = (e.usage && typeof e.usage === "object" ? e.usage : {}) as Record<string, unknown>;
      return [
        { kind: "usage", input: num(usage.input_tokens), cachedInput: num(usage.cached_input_tokens), output: num(usage.output_tokens) },
        { kind: "completed" },
      ];
    }
    case "turn.failed": {
      const error = e.error && typeof e.error === "object" ? str((e.error as Record<string, unknown>).message) : null;
      return [{ kind: "failed", error: (error ?? "Codex stopped with an error.").trim() }];
    }
    case "error": {
      // The CLI's own retries ("Reconnecting... 2/5 (…)") and stream errors: worth
      // keeping as the last word in case no turn.failed follows, never a verdict.
      const text = str(e.message);
      return text ? [{ kind: "notice", text: text.trim() }] : [];
    }
    default:
      return [];
  }
}

/**
 * A usage or plan limit in Codex's words: the ChatGPT plan's "You've hit your
 * usage limit", an API account out of quota, a 429. Distinct from the auth
 * refusal below — a limit comes good by itself, a refused credential does not.
 */
const CODEX_LIMIT_RE = /usage limit|usage_limit|insufficient_quota|exceeded your current quota|rate limit|rate_limit|\b429\b|too many requests/i;

export function isCodexLimit(text: string | null): boolean {
  return typeof text === "string" && CODEX_LIMIT_RE.test(text);
}

/** The plan or the account is out — as against a per-minute rate limit, which clears in moments. */
const CODEX_QUOTA_RE = /usage limit|usage_limit|insufficient_quota|exceeded your current quota/i;

/** How long a limit that names no reset is assumed to last: an hour for a spent plan or quota, two minutes for a rate limit. */
export const CODEX_QUOTA_LIMIT_MS = 60 * 60_000;
export const CODEX_RATE_LIMIT_MS = 2 * 60_000;

/** A refused or missing credential, as `codex exec` reports one. */
const CODEX_AUTH_RE = /\b401\b|unauthorized|incorrect api key|invalid api key|missing bearer|not logged in|refresh token|token (?:has )?expired|login again|sign in again/i;

export function isCodexAuthFailure(text: string | null): boolean {
  return typeof text === "string" && CODEX_AUTH_RE.test(text);
}

/**
 * When a limit says it frees up, as epoch ms — "try again in 2 hours 5
 * minutes", "in 37 seconds" — or null when it does not say.
 */
export function codexLimitResetAt(text: string, now: number): number | null {
  const m = /(?:try again|resets?|available again)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(text);
  if (!m) return null;
  let ms = 0;
  for (const part of m[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    const n = Number(part[1]);
    const unit = part[2].toLowerCase();
    if (unit.startsWith("d")) ms += n * 86_400_000;
    else if (unit.startsWith("h")) ms += n * 3_600_000;
    else if (unit.startsWith("m")) ms += n * 60_000;
    else ms += n * 1000;
  }
  return ms > 0 ? now + ms : null;
}

/** When a limit is over: the time it names, else the assumed length of its kind. */
export function codexLimitUntil(text: string, now: number): number {
  return codexLimitResetAt(text, now) ?? now + (CODEX_QUOTA_RE.test(text) ? CODEX_QUOTA_LIMIT_MS : CODEX_RATE_LIMIT_MS);
}
