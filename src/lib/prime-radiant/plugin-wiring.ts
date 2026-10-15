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
 * purpose — the plugin explicitly switched off, a bridge/unsafe-local mode, a
 * vault elsewhere, agent scope, a deny-list entry — is reported as a
 * `conflict` and left alone unless the caller passes `force` (the owner's own
 * "use Prime Radiant's vault" from its settings).
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
import { processStore } from "@/lib/process-store";
import path from "@/lib/runtime-path";
import { vaultDir } from "./paths";

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

function samePath(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.trim() === "") return false;
  const home = process.env.HOME ?? "";
  const expanded = a.startsWith("~/") && home ? path.join(home, a.slice(2)) : a;
  return path.isAbsolute(expanded) && path.resolve(expanded) === path.resolve(b);
}

/** What has to change in `config` for the plugin to read `vault` (pure). */
export function planMemoryWikiWiring(config: OpenClawConfig, vault: string): WiringPlan {
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
    if (vaultCfg?.path !== undefined) conflicts.push("other-vault-path");
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
  return planMemoryWikiWiring(config, vault);
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
    return { ...plan, wrote: false };
  }
  const batch: OpenclawConfigSetArgs[] = plan.writes.map((w) => [w.key, JSON.stringify(w.value), "--json"]);
  await runOpenclawConfigSetBatch(batch);
  const after = await memoryWikiWiringStatus(vault);
  return { ...after, wrote: true };
}
