import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { HERMES_DASHBOARD_UNIT } from "@/lib/hermes-dashboard-auth";
import { hermesHome } from "@/lib/hermes-env";

const execFileAsync = promisify(execFile);

/**
 * What this box DECLARES as its Hermes plugin set, and what the RUNNING
 * dashboard actually LOADED. They are different questions, and the whole defect
 * this module exists for is that every surface on the box answered the first one
 * while the owner was asking the second.
 *
 * THE MEASUREMENT (owner's box, 2026-09-18). The assistant installed and enabled
 * the `superpowers` plugin at 12:59 — `~/.hermes/plugins/superpowers/`, a row in
 * `.install-metadata.json`, its name under `plugins.enabled` in `config.yaml` —
 * and proved it worked by running `hermes chat -q`, which is a FRESH PROCESS.
 * The chat the owner was looking at is served by
 * `clawbox-hermes-dashboard.service`, up since 10:52. Hermes scans for plugins
 * once per process (`discover_plugins(force=True)` at start;
 * `_ensure_plugins_discovered()` returns early ever after, and nothing reachable
 * over the dashboard socket passes its `force` flag), so that process had never
 * heard of the plugin and never would. `hermes plugins list` said "enabled". The
 * chat had no such tool.
 *
 * So a reader that answers from `~/.hermes` is answering a question nobody
 * asked. This module answers both, and keeps them apart in its own vocabulary:
 * DECLARED is what the files say, LOADED is what the running process proved it
 * registered, and `null` for the latter means THIS BOX COULD NOT BE ASKED —
 * never "it loaded nothing".
 */

/** Where `hermes plugins install` records what it put on the box. */
function installLedgerPath(): string {
  return path.join(hermesHome(), "plugins", ".install-metadata.json");
}

function hermesConfigPath(): string {
  return path.join(hermesHome(), "config.yaml");
}

/**
 * The top-level `plugins:` block of config.yaml, verbatim, or "".
 *
 * WHY A BLOCK AND NOT THE FILE. `config.yaml` is rewritten by every Settings
 * save on this box — a provider key, a model change, a voice toggle — and the
 * dashboard's own `ExecStartPre` re-provisions `dashboard.basic_auth` into it on
 * every start. A watcher keyed on the whole file would bounce the box's chat
 * backend on each of those, and the re-provisioning one would make it a loop:
 * the dashboard restarts, rewrites the file, and is restarted for having
 * restarted.
 *
 * WHY COLUMN ZERO. `dashboard.hidden_plugins` and `plugins.entries.<id>` both
 * put the word further in, and a substring match on "plugins" would take the
 * former for the latter — a UI preference then reads as a plugin change. Only a
 * key at indent 0 opens the block, and the block ends at the next line at indent
 * 0 that is neither blank nor a comment.
 *
 * Both halves that decide loading are inside it: `plugins.enabled` (Hermes'
 * opt-in allow-list) and `plugins.disabled` (the deny-list `_plugin_status`
 * gives precedence to). A plugin the owner disables has changed the set as
 * surely as one they install.
 */
export function hermesPluginsBlock(yamlText: string): string {
  const lines = yamlText.split(/\r?\n/);
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^plugins\s*:/.test(line)) {
      inside = true;
      kept.push(line);
      continue;
    }
    if (!inside) continue;
    // Blank lines and comments belong to whatever block encloses them; they end
    // nothing. A line that starts with whitespace is inside the block.
    if (!line.trim() || /^\s/.test(line)) {
      kept.push(line);
      continue;
    }
    // A key back at column zero: the block is over.
    break;
  }
  // Trailing blank lines were swept up by the loop above and say nothing about
  // the plugin set; keeping them would make a stray newline elsewhere in the
  // file look like a change.
  return kept.join("\n").replace(/\s+$/, "");
}

/** What `~/.hermes` says this box's plugin set is. */
export interface HermesPluginDeclaration {
  /** Every plugin name the box declares, installed or merely enabled, sorted. */
  readonly names: readonly string[];
  /** The names under `plugins.enabled`, which is what Hermes will load. */
  readonly enabled: readonly string[];
  /**
   * A hash of the DECLARATION'S CONTENT — never an mtime.
   *
   * The dashboard rewrites `config.yaml` on every start, so two reads a restart
   * apart have different mtimes and identical meaning. Only a content hash can
   * tell "the owner installed something" from "the thing we restarted has
   * restarted", and getting that wrong is an endless restart loop over the box's
   * chat.
   */
  readonly signature: string;
  /** Newest mtime of the inputs, for reporting only. Null when unreadable. */
  readonly changedAt: number | null;
}

/** A file's text and mtime, or nulls. NEVER THROWS: see `readHermesPluginDeclaration`. */
async function readIfPresent(file: string): Promise<{ text: string; mtimeMs: number | null }> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, "utf-8"), fs.stat(file)]);
    return { text, mtimeMs: stat.mtimeMs };
  } catch {
    return { text: "", mtimeMs: null };
  }
}

/** The plugin names in an install ledger, or [] for anything unreadable. */
function ledgerNames(text: string): string[] {
  if (!text.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    // A HALF-WRITTEN FILE IS NOT AN EMPTY BOX. `hermes plugins install` writes
    // this, and a watcher polling every few seconds will catch it mid-write —
    // reproduced by writing `{"superpowers":` in the suite. Answering [] for
    // this one read is right (nothing can be established from it), and the
    // signature it produces differs from the settled one, so the debounce
    // window simply reopens and the next poll reads the finished file. What
    // must not happen is a throw, which would take the poll loop down for the
    // life of the web server.
    return [];
  }
}

/** The names under `enabled:` inside an already-extracted `plugins:` block. */
function enabledNames(block: string): string[] {
  const names: string[] = [];
  let inEnabled = false;
  let listIndent = -1;
  for (const line of block.split("\n")) {
    const key = /^(\s+)(enabled|disabled)\s*:/.exec(line);
    if (key) {
      inEnabled = key[2] === "enabled";
      listIndent = key[1].length;
      // An inline list — `enabled: [a, b]`, which is what `hermes config set`
      // writes when it is handed JSON.
      const inline = /:\s*\[(.*)\]\s*$/.exec(line);
      if (inline && inEnabled) {
        for (const item of inline[1].split(",")) {
          const name = item.trim().replace(/^["']|["']$/g, "");
          if (name) names.push(name);
        }
        inEnabled = false;
      }
      continue;
    }
    if (!inEnabled) continue;
    const item = /^(\s+)-\s*(.+?)\s*$/.exec(line);
    if (item && item[1].length > listIndent) {
      names.push(item[2].replace(/^["']|["']$/g, ""));
      continue;
    }
    if (line.trim()) inEnabled = false;
  }
  return names;
}

/**
 * Read what `~/.hermes` declares, cheaply enough to poll.
 *
 * NEVER THROWS, and answers an empty set for a box with no plugins at all —
 * which is most boxes, and is not an error. Two small local file reads; nothing
 * here spawns Hermes, because the caller is a loop that runs for the life of the
 * web server and a Python CLI cold start is seconds.
 */
export async function readHermesPluginDeclaration(): Promise<HermesPluginDeclaration> {
  const [ledger, config] = await Promise.all([
    readIfPresent(installLedgerPath()),
    readIfPresent(hermesConfigPath()),
  ]);
  const block = hermesPluginsBlock(config.text);
  const enabled = [...new Set(enabledNames(block))].sort();
  const names = [...new Set([...ledgerNames(ledger.text), ...enabled])].sort();
  // The two inputs are hashed as they are READ, not as they are parsed: a change
  // this build's parser does not understand — a future `plugins.entries` key, a
  // reformatted list — is still a change to the set Hermes will load, and the
  // restart is what makes it take effect either way. Parsing decides what the
  // owner is TOLD; the raw text decides whether anything happened.
  const signature = crypto
    .createHash("sha256")
    .update(ledger.text)
    .update(" ")
    .update(block)
    .digest("hex")
    .slice(0, 32);
  const mtimes = [ledger.mtimeMs, config.mtimeMs].filter((m): m is number => m !== null);
  return {
    names,
    enabled,
    signature,
    changedAt: mtimes.length ? Math.max(...mtimes) : null,
  };
}

/**
 * What systemd knows about the dashboard's CURRENT run.
 *
 * The invocation id is the one key that names exactly this activation —
 * `journalctl -u` sees every run the unit has ever had, and a plugin registered
 * by yesterday's process must never count as loaded by today's. Same idiom, and
 * the same reason, as `readSwapInvocationId` in `src/lib/harness-swap.ts`.
 */
async function dashboardRun(): Promise<{ invocationId: string | null; startedAtMs: number | null }> {
  const { stdout } = await execFileAsync(
    "/usr/bin/systemctl",
    ["show", HERMES_DASHBOARD_UNIT, "--property=InvocationID,ExecMainStartTimestampMonotonic"],
    { timeout: 5_000 },
  ).catch(() => ({ stdout: "" }));
  const props: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const id = props.InvocationID ?? "";
  // Monotonic microseconds since boot, turned into wall clock through the same
  // boot this process shares. These boxes have no RTC and step the clock when
  // NTP first lands, so a stored wall-clock start would be wrong across exactly
  // that window; the monotonic value is not, and the conversion is only ever
  // used for reporting.
  const monotonicUsec = Number(props.ExecMainStartTimestampMonotonic);
  const startedAtMs =
    Number.isFinite(monotonicUsec) && monotonicUsec > 0
      ? Date.now() - (os.uptime() * 1_000 - monotonicUsec / 1_000)
      : null;
  return {
    invocationId: /^[0-9a-f]{8,}$/i.test(id) ? id : null,
    startedAtMs,
  };
}

/**
 * Hermes' own "I have this plugin" line, as the plugin manager writes it.
 *
 * `hermes_cli/plugins.py` logs `Plugin '<name>' registered <what>: <which>` at
 * INFO for every registry a plugin lands in — tools, a context engine, a memory
 * provider, a dashboard-auth provider, an approval transport — with the id
 * unquoted in two of them. Both spellings are matched.
 */
const REGISTERED_RE = /\bPlugin\s+'?([A-Za-z0-9._-]+)'?\s+registered\b/g;

/** How much of the run's journal to read. Bounded: this is a request path. */
const JOURNAL_LINES = 500;

/**
 * The plugins the RUNNING dashboard proved it registered, or null.
 *
 * NULL IS THE IMPORTANT ANSWER and it must never be folded into `[]`. A box with
 * no journalctl, a unit systemd cannot name, a run whose id could not be read —
 * none of those says anything about what loaded, and answering "nothing loaded"
 * over them is the false-failure shape on the one reader whose job is to be
 * believed. It would have the route tell the owner their plugin is missing from
 * a dashboard that is serving it.
 *
 * AN ABSENT NAME IS NOT A NO EITHER, and the caller is told so in the type it
 * gets back: a plugin whose only registrations are tools logs them at DEBUG
 * (`plugins.py:500`), so it can be loaded and leave no INFO line. What a name
 * present here proves is the positive — this process has it — which is exactly
 * what a restart has to demonstrate.
 *
 * WHICH IS WHY AN EMPTY RESULT IS ALSO NULL. Measured on the owner's box
 * (2026-09-18): the running dashboard's whole journal for its current invocation
 * is 187 lines of `sessions.changed` events and the readiness banner, with not
 * one `Plugin … registered` among them — Hermes writes those on its Python
 * logger and this process does not route them out. Hermes always registers the
 * bundled `basic` dashboard-auth plugin on a gated bind, so ZERO registration
 * lines cannot mean "nothing loaded"; it can only mean this box does not publish
 * them. Returning `[]` there would have the route report every plugin on a
 * working device as missing, which is the false-failure this reader exists to
 * prevent — and it would do it on the exact box the feature was built for.
 *
 * `stale` (see `readHermesPluginState`) is the answer that still holds on such a
 * box: it is a fact about WHEN, not about what was logged.
 */
export async function readLoadedHermesPlugins(): Promise<string[] | null> {
  const { invocationId } = await dashboardRun();
  if (!invocationId) return null;
  const { stdout } = await execFileAsync(
    "/usr/bin/journalctl",
    [
      `_SYSTEMD_INVOCATION_ID=${invocationId}`,
      "-o",
      "cat",
      "--no-pager",
      "-n",
      String(JOURNAL_LINES),
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  ).catch(() => ({ stdout: null as string | null }));
  if (stdout === null) return null;
  const names = new Set<string>();
  for (const match of stdout.matchAll(REGISTERED_RE)) names.add(match[1]);
  // Nothing at all means this dashboard does not publish those lines — not that
  // it loaded no plugins. See the doc block above; this is the one branch that
  // was measured wrong on hardware before it shipped.
  return names.size ? [...names].sort() : null;
}

/** Declared, loaded, and whether the running process is behind the files. */
export interface HermesPluginState {
  readonly declared: readonly string[];
  /** Null when this box could not be asked — never "nothing loaded". */
  readonly loaded: readonly string[] | null;
  /**
   * True when the declaration changed AFTER the dashboard started, i.e. the
   * running process cannot have read it. Null when either half is unknown.
   *
   * This is the structural answer, and it holds for a plugin whose registrations
   * are all logged at DEBUG and therefore never appear in `loaded`.
   */
  readonly stale: boolean | null;
  readonly dashboardStartedAt: number | null;
}

/** Both questions, asked once. Never throws. */
export async function readHermesPluginState(): Promise<HermesPluginState> {
  const [declaration, loaded, run] = await Promise.all([
    readHermesPluginDeclaration(),
    readLoadedHermesPlugins().catch(() => null),
    dashboardRun().catch(() => ({ invocationId: null, startedAtMs: null })),
  ]);
  const stale =
    run.startedAtMs === null || declaration.changedAt === null
      ? null
      : declaration.changedAt > run.startedAtMs;
  return {
    declared: declaration.names,
    loaded,
    stale,
    dashboardStartedAt: run.startedAtMs,
  };
}
