/**
 * Point OpenClaw's bundled `memory-wiki` plugin at the Prime Radiant vault, in
 * ISOLATED mode — so the agent's own `wiki_search` / `wiki_get` /
 * `wiki_apply` and `memory_search corpus=all` read the same pages the app
 * shows.
 *
 * The keys written, and nothing else:
 *
 *   plugins.entries.memory-wiki.enabled                          true
 *   plugins.entries.memory-wiki.config.vaultMode                 "isolated"
 *   plugins.entries.memory-wiki.config.vault.path                <the vault>
 *   plugins.entries.memory-wiki.config.ingest.autoCompile        false
 *   plugins.entries.memory-wiki.config.render.createBacklinks    false
 *   plugins.entries.memory-wiki.config.render.createDashboards   false
 *
 * The last three keep the plugin a READER: left at their defaults it
 * compiles the vault on its first `wiki_status`/`wiki_search` — a
 * "## Related" block appended to every page, `<folder>/index.md` and
 * `reports/*.md` written beside them — and the vault's own lint then
 * refuses those files. Prime Radiant ignores what the plugin writes anyway
 * (see `plugin-files.ts`), but a vault the plugin leaves alone stays one the
 * owner can read.
 *
 * IDEMPOTENT: each key is written only when it differs, so a wired box makes
 * no write (and no gateway restart). NEVER CLOBBERS: a value the owner set on
 * purpose — the plugin explicitly switched off, a bridge/unsafe-local mode,
 * agent scope, a deny-list entry — is reported as a `conflict` and left alone
 * unless the caller passes `force` (the owner's own "use Prime Radiant's
 * vault" from its settings). The plugin's vault — the one `vault.path` names,
 * or its default `<state-dir>/wiki/main` when unset — is re-pointed only when
 * it holds no pages ({@link vaultHoldsPages}); one that does is the owner's
 * wiki, reported as `other-vault-path`, left as it is and logged.
 *
 * On the edition with no OpenClaw this is `unavailable`, never an error.
 *
 * SERVER ONLY.
 */

import {
  openclawIsAbsent,
  readConfigStrict,
  runOpenclawConfigSetBatch,
  type OpenClawConfig,
  type OpenclawConfigSetArgs,
} from "@/lib/openclaw-config";
import type { Dirent } from "fs";
import fs from "fs/promises";
import { openclawStateDir } from "@/lib/openclaw-state-store";
import { processStore } from "@/lib/process-store";
import path from "@/lib/runtime-path";
import { vaultDir } from "./paths";
import { isPluginOwnedPath } from "./plugin-files";

export const MEMORY_WIKI_PLUGIN_ID = "memory-wiki";
const ENTRY = `plugins.entries.${MEMORY_WIKI_PLUGIN_ID}`;
export const WIRING_KEYS = Object.freeze({
  enabled: `${ENTRY}.enabled`,
  vaultMode: `${ENTRY}.config.vaultMode`,
  vaultPath: `${ENTRY}.config.vault.path`,
  autoCompile: `${ENTRY}.config.ingest.autoCompile`,
  createBacklinks: `${ENTRY}.config.render.createBacklinks`,
  createDashboards: `${ENTRY}.config.render.createDashboards`,
});

/** The plugin's switches that make it write into the vault, each wanted `false`: `[section, key, config path]`. */
const VAULT_WRITE_SWITCHES = [
  ["ingest", "autoCompile", WIRING_KEYS.autoCompile],
  ["render", "createBacklinks", WIRING_KEYS.createBacklinks],
  ["render", "createDashboards", WIRING_KEYS.createDashboards],
] as const;

export type WiringConflict =
  | "plugin-disabled"
  | "plugin-denied"
  | "plugin-not-allowed"
  | "other-vault-mode"
  | "other-vault-path"
  | "agent-scope"
  /** The owner switched one of the plugin's vault writers on by hand. */
  | "plugin-writes";

export type WiringPlan =
  | { state: "wired"; vault: string }
  | { state: "needs-write"; vault: string; writes: Array<{ key: string; value: unknown }> }
  | { state: "conflict"; vault: string; conflicts: WiringConflict[]; writes: Array<{ key: string; value: unknown }> }
  | { state: "unavailable"; vault: string; reason: "no-openclaw" | "config-unreadable" };

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function expandHome(p: string): string {
  const home = process.env.HOME ?? "";
  return p.startsWith("~/") && home ? path.join(home, p.slice(2)) : p;
}

function samePath(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.trim() === "") return false;
  const expanded = expandHome(a);
  return path.isAbsolute(expanded) && path.resolve(expanded) === path.resolve(b);
}

/** A `vault.path` that names a folder (not unset, null or blank). */
function setVaultPath(config: OpenClawConfig): string | null {
  const entry = obj(obj(obj(config.plugins)?.entries)?.[MEMORY_WIKI_PLUGIN_ID]);
  const p = obj(obj(entry?.config)?.vault)?.path;
  return typeof p === "string" && p.trim() !== "" ? p : null;
}

/**
 * The folder the plugin reads now: the `vault.path` set, or — unset — its
 * default, `<state-dir>/wiki/main` (pinned OpenClaw's memory-wiki: the state
 * dir is `OPENCLAW_STATE_DIR`, else the OpenClaw home). Null when that path is
 * not absolute.
 */
export function pluginVaultNow(config: OpenClawConfig): string | null {
  const set = setVaultPath(config);
  const p = set === null ? path.join(openclawStateDir(), "wiki", "main") : expandHome(set);
  return path.isAbsolute(p) ? path.resolve(p) : null;
}

/** The most entries {@link vaultHoldsPages} looks at before it calls a folder full. */
const PROBE_ENTRIES = 2000;
/** Top-level files a vault holds that are no page of anybody's. */
const SCAFFOLD_FILES = new Set(["index.md", "log.md", "AGENTS.md"]);

/**
 * Whether the folder holds anything but the plugin's own scaffolding
 * (`WIKI.md`, `inbox.md`, `reports/`, `<group>/index.md`, dot files, the
 * top-level index): a page, a source, any file of the owner's. Missing is
 * empty; a file in its place, a folder it cannot read or one too big to look
 * through counts as holding pages — never re-point what was not seen to be
 * empty. Reads names only, never a file's contents.
 */
export async function vaultHoldsPages(dir: string): Promise<boolean> {
  let seen = 0;
  const walk = async (abs: string, rel: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (++seen > PROBE_ENTRIES) return true;
      if (e.name.startsWith(".")) continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (isPluginOwnedPath(childRel) || (rel === "" && SCAFFOLD_FILES.has(e.name))) continue;
      if (e.isDirectory()) {
        if (await walk(path.join(abs, e.name), childRel)) return true;
        continue;
      }
      return true;
    }
    return false;
  };
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return walk(dir, "");
}

/**
 * What has to change in `config` for the plugin to read `vault` (pure).
 * `currentVaultEmpty` says whether the vault the plugin reads now holds no
 * pages (see {@link vaultHoldsPages}); unknown, a `vault.path` set elsewhere
 * is the owner's and an unset one is written.
 */
export function planMemoryWikiWiring(config: OpenClawConfig, vault: string, currentVaultEmpty?: boolean): WiringPlan {
  const plugins = obj(config.plugins);
  const entry = obj(obj(plugins?.entries)?.[MEMORY_WIKI_PLUGIN_ID]);
  const cfg = obj(entry?.config);
  const vaultCfg = obj(cfg?.vault);

  const conflicts: WiringConflict[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];

  const deny = plugins?.deny;
  if (Array.isArray(deny) && deny.includes(MEMORY_WIKI_PLUGIN_ID)) conflicts.push("plugin-denied");
  const allow = plugins?.allow;
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(MEMORY_WIKI_PLUGIN_ID)) conflicts.push("plugin-not-allowed");

  if (entry?.enabled !== true) {
    if (entry?.enabled === false) conflicts.push("plugin-disabled");
    writes.push({ key: WIRING_KEYS.enabled, value: true });
  }
  if (cfg?.vaultMode !== "isolated") {
    if (cfg?.vaultMode !== undefined) conflicts.push("other-vault-mode");
    writes.push({ key: WIRING_KEYS.vaultMode, value: "isolated" });
  }
  if (!samePath(vaultCfg?.path, vault)) {
    // The vault the plugin reads now (set, or its default) is re-pointed only when it holds no pages.
    const keep = currentVaultEmpty === undefined ? setVaultPath(config) !== null : !currentVaultEmpty;
    if (keep) conflicts.push("other-vault-path");
    writes.push({ key: WIRING_KEYS.vaultPath, value: vault });
  }
  // Agent scope turns vault.path into a PARENT; Prime Radiant is one vault.
  if (vaultCfg?.scope === "agent") conflicts.push("agent-scope");
  // Unset means the plugin's default, `true`: written `false`. Set by hand to
  // anything else is the owner's, reported once however many there are.
  let writerOn = false;
  for (const [section, key, configKey] of VAULT_WRITE_SWITCHES) {
    const value = obj(cfg?.[section])?.[key];
    if (value === false) continue;
    if (value !== undefined) writerOn = true;
    writes.push({ key: configKey, value: false });
  }
  if (writerOn) conflicts.push("plugin-writes");

  if (conflicts.length > 0) return { state: "conflict", vault, conflicts, writes };
  if (writes.length > 0) return { state: "needs-write", vault, writes };
  return { state: "wired", vault };
}

export async function memoryWikiWiringStatus(vault: string = vaultDir()): Promise<WiringPlan> {
  if (openclawIsAbsent()) return { state: "unavailable", vault, reason: "no-openclaw" };
  let config: OpenClawConfig;
  try {
    config = await readConfigStrict();
  } catch {
    return { state: "unavailable", vault, reason: "config-unreadable" };
  }
  let currentVaultEmpty: boolean | undefined;
  if (!samePath(setVaultPath(config), vault)) {
    const now = pluginVaultNow(config);
    // A relative path is the plugin's to resolve: not seen to be empty, so kept.
    currentVaultEmpty = now !== null && (path.resolve(now) === path.resolve(vault) || !(await vaultHoldsPages(now)));
  }
  return planMemoryWikiWiring(config, vault, currentVaultEmpty);
}

export interface EnsureWiringOptions {
  vault?: string;
  /**
   * Resolve the conflicts that ONLY need our own keys: a disabled plugin, a
   * different mode or vault path, a vault writer switched on. A deny/allow
   * list and agent scope are never edited from here — they say something
   * about the whole box, not about this vault.
   */
  force?: boolean;
}

export type WiringResult = WiringPlan & { wrote: boolean };

const FORCEABLE: ReadonlySet<WiringConflict> = new Set(["plugin-disabled", "other-vault-mode", "other-vault-path", "plugin-writes"]);

/**
 * One wiring at a time, process-wide: two windows opening the app together
 * would otherwise both read the unwired config, both plan the same batch and
 * both write it (two gateway restarts). Chained, the second one plans against
 * what the first one wrote and writes nothing. In `processStore` because the
 * routes and the boot layer compile this module twice.
 */
const wiringQueue = processStore("prime-radiant:wiring", () => ({ tail: Promise.resolve() as Promise<unknown> }));

/** Make the plugin read the vault. One batched config write, or none. */
export function ensureMemoryWikiWiring(options: EnsureWiringOptions = {}): Promise<WiringResult> {
  const run = wiringQueue.tail.then(
    () => wireOnce(options),
    () => wireOnce(options),
  );
  // A failed write is its caller's to report, never the next caller's to inherit.
  wiringQueue.tail = run.catch(() => undefined);
  return run;
}

async function wireOnce(options: EnsureWiringOptions): Promise<WiringResult> {
  const vault = options.vault ?? vaultDir();
  const plan = await memoryWikiWiringStatus(vault);
  if (plan.state === "wired" || plan.state === "unavailable") return { ...plan, wrote: false };
  if (plan.state === "conflict" && !(options.force && plan.conflicts.every((c) => FORCEABLE.has(c)))) {
    if (plan.conflicts.includes("other-vault-path")) {
      console.warn("[prime-radiant] memory-wiki reads another vault that holds pages; its vault path was left as it is.");
    }
    return { ...plan, wrote: false };
  }
  const batch: OpenclawConfigSetArgs[] = plan.writes.map((w) => [w.key, JSON.stringify(w.value), "--json"]);
  await runOpenclawConfigSetBatch(batch);
  const after = await memoryWikiWiringStatus(vault);
  return { ...after, wrote: true };
}
