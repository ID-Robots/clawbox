import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "@/lib/runtime-path";
import { promisify } from "util";
import { HERMES_DASHBOARD_UNIT } from "@/lib/hermes-dashboard-auth";
import { hermesHome } from "@/lib/hermes-env";
import { processStore } from "@/lib/process-store";
import { parseYamlFlowSequence, parseYamlScalar, splitYamlComment } from "@/lib/yaml-block-edit";

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
  // Blank lines and COMMENTS at column zero belong to whatever block encloses
  // them and end nothing — YAML has no rule that a `#` closes a mapping. They
  // are held back rather than kept outright, because the same lines sitting
  // AFTER the block belong to whatever comes next: held, they are committed
  // only when a genuine in-block line follows, and dropped at the break. A
  // comment at column zero used to end the extraction, which silently cut
  // `disabled:` — the deny-list `_plugin_status` gives precedence to — out of
  // the signature on any box whose config.yaml carries one.
  let pending: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^plugins\s*:/.test(line)) {
      inside = true;
      kept.push(line);
      continue;
    }
    if (!inside) continue;
    if (!line.trim() || /^\s*#/.test(line)) {
      pending.push(line);
      continue;
    }
    // A line that starts with whitespace is inside the block.
    if (/^\s/.test(line)) {
      kept.push(...pending, line);
      pending = [];
      continue;
    }
    // A key back at column zero: the block is over, and anything held since the
    // last real line belongs to what follows it.
    break;
  }
  // Trailing blank lines say nothing about the plugin set; keeping them would
  // make a stray newline elsewhere in the file look like a change.
  return kept.join("\n").replace(/\s+$/, "");
}

/** What `~/.hermes` says this box's plugin set is. */
export interface HermesPluginDeclaration {
  /** Every plugin name the box declares, installed or merely enabled, sorted. */
  readonly names: readonly string[];
  /** The names under `plugins.enabled`, which is what Hermes will load… */
  readonly enabled: readonly string[];
  /**
   * …unless `plugins.disabled` names them, which WINS: `_plugin_status` is
   * `"disabled" if names & disabled else "enabled" if names & enabled`.
   *
   * The two lists overlap in ordinary use, which is why this is carried rather
   * than folded into `enabled` at the parse. `hermes plugins disable superpowers`
   * discards the resolved KEY and its leaf from the allow-list and adds the key
   * to the deny-list (`cmd_disable` → `_discard_key_and_leaf`), so the bare name
   * a person originally wrote is left sitting in `enabled` — measured on the
   * owner's box.
   */
  readonly disabled: readonly string[];
  /**
   * A hash of the PARSED plugin set — never an mtime, and never the raw text.
   *
   * The dashboard rewrites `config.yaml` on every start, so two reads a restart
   * apart have different mtimes and identical meaning. Only a hash of what the
   * file SAYS can tell "the owner installed something" from "the thing we
   * restarted has restarted", and getting that wrong is an endless restart loop
   * over the box's chat.
   *
   * AND A HASH OF THE TEXT IS NOT THAT HASH, which cost a chat window before it
   * was noticed: `scripts/register-mcp.sh` re-serialises the whole config
   * through `yaml.safe_dump` whenever anything at all changed, normalising the
   * plugins block's indentation, quoting and comments — and it is spawned
   * fire-and-forget at every web-server boot (`production-server.js`) and again
   * from the ClawBox-MCP toggle in Settings. Its write lands well after the
   * watcher's first tick, so the owner toggled "expose ClawBox tools to the
   * assistant", and eight seconds later their chat closed with "The assistant
   * restarted to load the plugin …" over a set that had not moved by one name.
   * So the sorted `enabled` and `disabled` names and the install ledger's
   * name→revision rows are what is hashed: a re-serialisation of the same set
   * is the same signature, and a real change to any of the three is not.
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

/**
 * The install ledger as `name → recorded revision`, or {} for anything
 * unreadable.
 *
 * THE REVISION IS PART OF THE SET, not decoration: `hermes plugins update`
 * pulls the plugin's git checkout and writes the new HEAD here
 * (`plugins_cmd.py:_pull_plugin_update`). The name has not moved and the code
 * has, and the process serving chat is holding the old one — which is the same
 * "restart to pick it up" as an install.
 *
 * A HALF-WRITTEN FILE IS NOT AN EMPTY BOX. `hermes plugins install` writes
 * this, and a watcher polling every few seconds will catch it mid-write —
 * reproduced by writing `{"superpowers":` in the suite. Answering {} for that
 * one read is right (nothing can be established from it) and, because the
 * signature is built from what was PARSED, it is also the answer the settled
 * file gave a moment earlier: no window opens over a partial write, and the
 * next poll reads the finished file. What must not happen is a throw, which
 * would take the poll loop down for the life of the web server.
 */
function ledgerEntries(text: string): Record<string, string> {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, row] of Object.entries(parsed as Record<string, unknown>)) {
      const revision = row && typeof row === "object" ? (row as { revision?: unknown }).revision : undefined;
      out[name] = typeof revision === "string" ? revision : "";
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The names under `enabled:` — or `disabled:` — inside an already-extracted
 * `plugins:` block.
 *
 * BOTH BLOCK LAYOUTS, because this box has two writers and only one of them was
 * ever read. Hermes' own dumper forces `indentless=False`:
 *
 *     plugins:
 *       enabled:
 *         - superpowers
 *
 * `scripts/register-mcp.sh` re-serialises the whole file with plain
 * `yaml.safe_dump`, and PyYAML's default in a mapping context is an INDENTLESS
 * block sequence:
 *
 *     plugins:
 *       enabled:
 *       - superpowers
 *
 * The old rule accepted an item only when it was indented FURTHER than the key,
 * so on every box that script had ever had something to change — which is every
 * box that got the EMAIL-directive hook — `plugins.enabled` read as EMPTY, and
 * `stale`, being `enabled.some(...)`, was `false` for ever. The MCP tool then
 * told the owner "the agent now serving chat has read the current plugin set"
 * about a plugin that had never loaded. An item belongs to the list when it sits
 * at the key's indent or deeper; anything shallower is a level up.
 *
 * COMMENTS AND QUOTES ARE THE READER'S JOB, not a regex's:
 * `- superpowers # installed 2026-09-18` is one name and a note, while
 * `- "weird # name"` is one name with a hash in it. Read the wrong way round,
 * the first invents a name no registry can ever match — a permanent `stale` and
 * a chat restart that cannot fix it. {@link splitYamlComment} is the one place
 * that rule lives.
 *
 * NOT READ, and said out loud: a `plugins:` written as a FLOW MAPPING at column
 * zero (`plugins: {enabled: [a]}`). Neither writer on the box produces it —
 * PyYAML is called with `default_flow_style=False`, Hermes' dumper likewise, and
 * ClawBox's own editor refuses flow shapes outright — so it can only arrive by
 * hand, and the previous reader did not understand it either.
 */
/**
 * The indent a DIRECT child of `plugins:` sits at, or -1 for a block with none.
 *
 * The shallowest indented line in the block, which is what `plugins:`' own
 * children share — an indentless block sequence puts its items at the key's
 * indent too, so items never make this smaller than the key above them. Blanks
 * and comments say nothing about structure and are skipped, and the `plugins:`
 * line itself sits at column zero and is not a child.
 */
function childIndentOf(block: string): number {
  let indent = -1;
  for (const line of block.split("\n")) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const leading = /^(\s+)\S/.exec(line);
    if (!leading) continue;
    if (indent < 0 || leading[1].length < indent) indent = leading[1].length;
  }
  return indent;
}

function listedNames(block: string, wanted: "enabled" | "disabled"): string[] {
  const names: string[] = [];
  let inList = false;
  let listIndent = -1;
  // WHOSE `enabled:` IS IT? The key used to match at any depth inside the
  // block, so a plugin's own settings under `plugins.entries.<id>` — the one
  // thing the block extraction exists to keep out of the set — could put its
  // members into the box's declaration when its schema happened to have a
  // list-valued key called `enabled` or `disabled`. A ghost name is a permanent
  // `stale`/`null` and a signature that moves when a preference does. Only a
  // DIRECT child of `plugins:` is the box's plugin list.
  const childIndent = childIndentOf(block);
  for (const line of block.split("\n")) {
    const key = /^(\s+)(enabled|disabled)\s*:(.*)$/.exec(line);
    if (key && key[1].length !== childIndent) {
      // A nested key of the same name. It is not the list, and — unlike a line
      // this loop does not recognise at all — it is not part of one either, so
      // whatever list was open ends here.
      inList = false;
      continue;
    }
    if (key) {
      inList = key[2] === wanted;
      listIndent = key[1].length;
      const inline = splitYamlComment(key[3]).value.trim();
      // Nothing after the colon: a block sequence follows on the next lines.
      if (!inline) continue;
      // An inline list — `enabled: [a, b]`, which is what `hermes config set`
      // writes when it is handed JSON — with or without a note after it.
      if (inList) {
        for (const member of parseYamlFlowSequence(inline) ?? []) {
          const name = parseYamlScalar(member)?.trim();
          if (name) names.push(name);
        }
      }
      // Whatever it was, the value was on this line: no block sequence follows.
      inList = false;
      continue;
    }
    if (!inList) continue;
    // A comment or a blank line inside the list is not the end of it, for the
    // same reason it is not the end of the block.
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^(\s*)-(?:\s+(.*))?$/.exec(line);
    if (item && item[1].length >= listIndent) {
      const raw = splitYamlComment(item[2] ?? "").value.trim();
      const name = raw ? parseYamlScalar(raw)?.trim() : "";
      if (name) names.push(name);
      continue;
    }
    inList = false;
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
  const enabled = [...new Set(listedNames(block, "enabled"))].sort();
  const disabled = [...new Set(listedNames(block, "disabled"))].sort();
  const installed = ledgerEntries(ledger.text);
  const names = [...new Set([...Object.keys(installed), ...enabled])].sort();
  // WHAT THE SET IS, not how it happens to be spelled today — see `signature` on
  // the type above for the chat window that bought this back. `disabled` is
  // hashed beside `enabled` because `_plugin_status` gives the deny-list
  // precedence, so a plugin the owner disables has changed the set as surely as
  // one they install; the ledger's revisions are hashed because an update
  // changes the code under an unchanged name. A key inside the block that is
  // neither — a `plugins.entries.<id>` preference — deliberately is not: it does
  // not decide what loads, and hashing it is what made a whole-file
  // re-serialisation read as a plugin change.
  const signature = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        enabled,
        disabled,
        installed: Object.keys(installed)
          .sort()
          .map((name) => [name, installed[name]]),
      }),
    )
    .digest("hex")
    .slice(0, 32);
  const mtimes = [ledger.mtimeMs, config.mtimeMs].filter((m): m is number => m !== null);
  return {
    names,
    enabled,
    disabled,
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
  // HERMES' OWN ANSWER FIRST — leverage the harness before re-deriving it.
  // `plugins.list` is a method on the dashboard socket ClawBox already dials
  // (`tui_gateway/methods_tools.py`, verified against the pinned checkout), and
  // it is built from `get_plugin_manager()._plugins` — the running process's own
  // registry rather than a log of what it once printed. That is exactly the
  // question this function exists to answer, and unlike the journal scrape it
  // works on the owner's box.
  const fromHarness = await loadedFromDashboard();
  // `[]` is an ANSWER here (rows, none enabled) and truthiness would drop it.
  if (fromHarness !== null) return fromHarness;
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

/** How long `plugins.list` may take. It is a dict comprehension over a registry
 *  the process already holds — not a reload — so seconds, not tens of them. */
const PLUGINS_LIST_TIMEOUT_MS = 8_000;

/**
 * What the RUNNING dashboard's own plugin registry says, or null.
 *
 * NULL FOR AN ANSWER WITH NO ROWS AT ALL, by the same rule the journal scrape
 * follows: the dashboard runs `discover_plugins(force=True)` at start and Hermes
 * ships bundled plugins, so a registry with nothing in it is far more likely to
 * be a shape this build does not understand than a box with none — and "nothing
 * is loaded" is the one answer that would have the route tell an owner their
 * working plugin is missing.
 *
 * AN ANSWER WITH ROWS, NONE OF THEM ENABLED, IS NOT THAT. It is the registry
 * saying exactly what this feature is about — the process HAS the manifests and
 * has none of them on — so it comes back as `[]`, established, and the staleness
 * that follows from it is a fact rather than a guess. The difference is "the
 * process did not answer" against "the process answered no".
 *
 * The ENABLED ones, because that is what "loaded" means to the person asking:
 * `_plugins` holds every manifest discovery found, bundled ones included, each
 * with the verdict the config gave it.
 */
async function loadedFromDashboard(): Promise<string[] | null> {
  const { dashboardRpc } = await import("@/lib/hermes-dashboard-rpc");
  const result = await dashboardRpc("plugins.list", {}, { timeoutMs: PLUGINS_LIST_TIMEOUT_MS }).catch(() => null);
  const rows = (result as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const names = new Set<string>();
  for (const raw of rows) {
    const row = raw as { name?: unknown; enabled?: unknown };
    // `enabled` absent is treated as on, the same default the RPC itself uses
    // (`getattr(i, "enabled", True)`): an older Hermes that answers with names
    // alone still tells us what the process has.
    if (typeof row?.name === "string" && row.name.trim() && row.enabled !== false) {
      names.add(row.name.trim());
    }
  }
  return [...names].sort();
}

/** How long `plugins.manage` may take. It re-discovers from disk and consults
 *  the live plugin catalogue (5 s upstream timeout, 6 h cache), so it is bounded
 *  wider than `plugins.list` and asked only when something needs resolving. */
const PLUGINS_MANAGE_TIMEOUT_MS = 15_000;

/**
 * Registry key → manifest name, from Hermes' OWN plugin discovery, or null.
 *
 * THE HALF `plugins.list` CANNOT ANSWER. That RPC is built from
 * `get_plugin_manager()._plugins`, whose keys are `manifest_key(manifest)` =
 * `manifest.key or manifest.name` (`hermes_cli/plugins_manifest.py`), and a
 * nested plugin's key is `<prefix>/<directory>` — which says nothing about the
 * name a person enables it under. `plugins.manage {action:"list"}` is the one
 * method that carries BOTH (`tui_gateway/methods_tools.py:_plugin_rows`), so it
 * is what the match below is built from rather than a rule re-derived here.
 *
 * Null for a box that could not be asked — an older Hermes with no such method,
 * a dashboard that did not answer — and the caller turns that into "could not
 * establish", never into "no". Asked LAZILY, because a box whose declared names
 * are all registry keys needs none of it.
 */
/**
 * How long a name↔key map is reused before it is asked for again.
 *
 * Short, and a memo rather than a cache: the map changes only when a plugin is
 * INSTALLED or REMOVED, and `plugins.manage {action:"list"}` is the expensive
 * one of the two RPCs here — `_plugin_rows` re-discovers every manifest from
 * disk and consults the catalogue, which is why it is budgeted at 15 s. Nothing
 * polls the GET today, so this is not hot; what the memo buys is that it cannot
 * BECOME hot, which is the difference the deny-list branch made when it turned
 * "asked only when a name will not resolve" into "asked on every read for any
 * box whose owner has switched a plugin off".
 *
 * Deliberately far shorter than the thing it describes is stable for. The first
 * call in a process always asks — which is the watcher's first look, the one
 * read whose answer arms an unattended restart — and a plugin installed while a
 * memo stands resolves within the window. Only a SUCCESSFUL map is kept: a box
 * that could not be asked must be asked again, never remembered as "no".
 */
const PLUGIN_NAME_MEMO_MS = 30_000;

/**
 * The memo lives in the process store, not in a module-level `let`.
 *
 * This file is reached both by `src/instrumentation.ts`'s `require` and by the
 * routes' `import`, which Next compiles as two different modules in the one web
 * server — see `process-store.ts`. Two memos would not be wrong here, only
 * wasteful, but the rule is cheaper to keep than to reason about each time.
 */
function pluginNameMemo(): { at: number; byKey: Map<string, string> } | null {
  return processStore<{ value: { at: number; byKey: Map<string, string> } | null }>(
    "clawbox.hermes-plugin-name-memo",
    () => ({ value: null }),
  ).value;
}

function rememberPluginNames(byKey: Map<string, string>): void {
  processStore<{ value: { at: number; byKey: Map<string, string> } | null }>(
    "clawbox.hermes-plugin-name-memo",
    () => ({ value: null }),
  ).value = { at: Date.now(), byKey };
}

/** Test seam: forget the memo, so each case asks for itself. */
export function _resetHermesPluginNameMemoForTests(): void {
  processStore<{ value: unknown }>("clawbox.hermes-plugin-name-memo", () => ({ value: null })).value = null;
}

async function pluginNameByKey(): Promise<Map<string, string> | null> {
  const memo = pluginNameMemo();
  if (memo && Date.now() - memo.at < PLUGIN_NAME_MEMO_MS) return memo.byKey;
  const { dashboardRpc } = await import("@/lib/hermes-dashboard-rpc");
  const result = await dashboardRpc(
    "plugins.manage",
    { action: "list" },
    { timeoutMs: PLUGINS_MANAGE_TIMEOUT_MS },
  ).catch(() => null);
  const rows = (result as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const byKey = new Map<string, string>();
  for (const raw of rows) {
    const row = raw as { name?: unknown; key?: unknown };
    if (typeof row?.key === "string" && typeof row?.name === "string" && row.key.trim() && row.name.trim()) {
      byKey.set(row.key.trim(), row.name.trim());
    }
  }
  if (!byKey.size) return null;
  rememberPluginNames(byKey);
  return byKey;
}

/**
 * Does the running registry carry the plugin the box declares by this name?
 * True, false, or NULL for "this box could not be asked".
 *
 * HERMES' OWN RULE, mirrored rather than approximated: `_plugin_status` builds
 * `names = {manifest name, registry key}` and intersects it with the enabled set
 * (`hermes_cli/plugins_cmd.py`). So a declared name matches a running plugin
 * when it IS that plugin's registry key, or when it is the manifest name behind
 * it — and never in any other way.
 *
 * WHAT WAS HERE BEFORE was a path-segment match (`image_gen/clawai`.split("/")
 * contains `clawai`), which happened to cover the two plugins measured on the
 * owner's box and is both looser and stricter than the real rule. Stricter is
 * the expensive direction: a plugin installed into a directory whose name
 * differs from its manifest `name`, enabled under that name, has a key carrying
 * neither — `stale` was then true for ever, the MCP tool warned "the plugin is
 * NOT loaded yet" about a box that was serving it, and the next config write
 * bounced the owner's chat for a restart that could not change the answer.
 *
 * NULL RATHER THAN FALSE when the name↔key map could not be read, because
 * "this build cannot resolve a nested key" is not evidence that a plugin is
 * missing, and `stale: true` is what arms an unattended restart of the chat.
 */
/**
 * Do these two declared strings name the SAME plugin?
 *
 * Hermes' identity for a plugin is the pair `{manifest name, registry key}`, and
 * a person may write either into `plugins.enabled` or `plugins.disabled`. With
 * no name↔key map only the literal answer can be given, which is the
 * conservative direction here: an unmatched pair leaves the enabled entry in
 * play and its verdict comes back as "could not establish".
 */
function samePlugin(a: string, b: string, nameByKey: ReadonlyMap<string, string> | null): boolean {
  if (a === b) return true;
  if (!nameByKey) return false;
  return nameByKey.get(a) === b || nameByKey.get(b) === a;
}

function registryHas(
  declared: string,
  keys: ReadonlySet<string>,
  nameByKey: ReadonlyMap<string, string> | null,
): boolean | null {
  if (keys.has(declared)) return true;
  if (!nameByKey) return null;
  for (const key of keys) {
    if (nameByKey.get(key) === declared) return true;
  }
  return false;
}

/** Declared, loaded, and whether the running process is behind the files. */
export interface HermesPluginState {
  readonly declared: readonly string[];
  /** Null when this box could not be asked — never "nothing loaded". */
  readonly loaded: readonly string[] | null;
  /**
   * The process serving chat is BEHIND THE FILES: something the box declares as
   * enabled is not enabled in the running registry. Null when it could not be
   * established.
   *
   * DERIVED FROM `loaded`, NEVER FROM AN MTIME. It used to compare
   * `max(mtime(ledger), mtime(config.yaml))` against the dashboard's start —
   * and `config.yaml` is rewritten by every Settings save on this box and by
   * the dashboard's own `ExecStartPre`, which is the exact false positive the
   * block extraction exists to prevent. An owner changing the assistant's model
   * at 14:00 made this `true`, which the MCP tool words as "the agent is still
   * behind the files — the plugin is NOT loaded yet". The registry answers the
   * real question, so it is what answers.
   *
   * ONE-DIRECTIONAL on purpose: a name the box declares that the process does
   * not have. A plugin the process carries that the declaration no longer names
   * (a bundled one, one the owner just disabled) does NOT make this true —
   * otherwise a box whose registry and config can never agree would report work
   * outstanding for ever, and the watcher's first look would bounce the chat at
   * every web-server boot. A disable still reaches the watcher, through the
   * declaration's signature.
   *
   * THE ACCEPTED RESIDUAL, named rather than left as a clean sheet. A `true`
   * here is honest about the files and the registry, and there are two real
   * boxes on which it can never be made false by restarting:
   *
   *  - a plugin REMOVED from the build but still listed in `plugins.enabled`.
   *    Hermes warns about exactly this itself ("Removed Hermes plugin %s is
   *    still listed in plugins.enabled", `hermes_cli/plugins.py`), so a box
   *    upgraded past a removal carries it;
   *  - a plugin whose own gate fails, which lands in `_plugins` with
   *    `enabled=False` and is therefore filtered out of the running set here.
   *
   * Paired with {@link changedAfterStart}, which any Settings save re-arms, the
   * watcher's first look bounces the owner's chat once for a restart that
   * cannot change the answer. It is BOUNDED and cannot loop — after the bounce
   * the dashboard's start is newer than those files — so it is at most one
   * outage per (Settings save → web-server restart) pair, which is the price of
   * not reading "the registry disagrees" as "nothing is owed". Tightening it
   * would mean requiring the name to be one `plugins.manage` actually
   * discovered before calling it missing, and that trades this residual for a
   * silent `null` on a genuinely absent plugin.
   */
  readonly stale: boolean | null;
  readonly dashboardStartedAt: number | null;
  /**
   * The declaration's inputs were touched AFTER the dashboard started, so the
   * running process cannot have read what is on disk now. Null when either half
   * is unknown.
   *
   * A WEAKER FACT THAN {@link stale} AND A DIFFERENT ONE. It is an mtime, so
   * every Settings save makes it true — config.yaml is rewritten by each of
   * them — which is exactly why it may not stand alone. What it has that
   * `stale` has not is that it is SELF-LIMITING: once the dashboard has been
   * restarted, its start is newer than any of those files, so a box whose
   * declaration and registry can never agree cannot be bounced twice for the
   * same reason. The watcher's first look requires both.
   */
  readonly changedAfterStart: boolean | null;
  /** The declaration's content hash, so a caller can record what it acted on. */
  readonly signature: string;
}

/** Both questions, asked once. Never throws. */
export async function readHermesPluginState(): Promise<HermesPluginState> {
  const [declaration, loaded, run] = await Promise.all([
    readHermesPluginDeclaration(),
    readLoadedHermesPlugins().catch(() => null),
    dashboardRun().catch(() => ({ invocationId: null, startedAtMs: null })),
  ]);
  const running = loaded === null ? null : new Set(loaded);
  // THE NAME↔KEY MAP IS ASKED FOR ONLY WHEN IT IS NEEDED. A declared name that
  // IS a registry key is settled by the set alone; anything left over — and any
  // deny-list entry that has to be paired with an allow-list one — is what
  // `plugins.manage` exists to resolve, and on most boxes there is nothing.
  const looseNames = running === null ? [] : declaration.enabled.filter((name) => !running.has(name));
  const nameByKey =
    looseNames.length > 0 || declaration.disabled.length > 0 ? await pluginNameByKey() : null;
  // THE DENY-LIST WINS, as it does in `_plugin_status`. `hermes plugins disable`
  // leaves the bare name a person wrote in `plugins.enabled` and adds the
  // resolved key to `plugins.disabled`, so a box whose owner switched a plugin
  // OFF declares it in both lists — and the running registry is right not to
  // have it. Read from `enabled` alone, `stale` was permanently true there: the
  // MCP tool warned "the agent is still behind the files" about a working box,
  // and the watcher's first look would bounce the owner's chat at the next
  // web-server boot over a restart that cannot change the answer.
  const unresolved = looseNames.filter(
    (name) => !declaration.disabled.some((denied) => samePlugin(name, denied, nameByKey)),
  );
  // A DEFINITE MISSING NAME OUTRANKS AN UNRESOLVED ONE, and an unresolved one
  // outranks "all present": `true` is what arms a restart of the owner's chat,
  // so it is said only about a name the harness itself placed as absent, and
  // everything this build could not establish answers null instead of guessing.
  let missing = false;
  let unknown = false;
  for (const name of unresolved) {
    const has = registryHas(name, running as ReadonlySet<string>, nameByKey);
    if (has === false) missing = true;
    else if (has === null) unknown = true;
  }
  const stale = running === null ? null : missing ? true : unknown ? null : false;
  return {
    declared: declaration.names,
    loaded,
    stale,
    dashboardStartedAt: run.startedAtMs,
    changedAfterStart:
      run.startedAtMs === null || declaration.changedAt === null
        ? null
        : declaration.changedAt > run.startedAtMs,
    signature: declaration.signature,
  };
}
