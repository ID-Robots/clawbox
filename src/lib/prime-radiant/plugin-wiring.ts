/**
 * Point OpenClaw's bundled `memory-wiki` plugin at the Prime Radiant vault, in
 * ISOLATED mode — so the agent's own `wiki_search` / `wiki_get` /
 * `wiki_apply` and `memory_search corpus=all` read the same pages the app
 * shows.
 *
 * The keys written, and nothing else:
 *
 *   plugins.entries.memory-wiki.enabled            true
 *   plugins.entries.memory-wiki.config.vaultMode   "isolated"
 *   plugins.entries.memory-wiki.config.vault.path  <the vault>
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
import path from "@/lib/runtime-path";
import { vaultDir } from "./paths";

export const MEMORY_WIKI_PLUGIN_ID = "memory-wiki";
const ENTRY = `plugins.entries.${MEMORY_WIKI_PLUGIN_ID}`;
export const WIRING_KEYS = Object.freeze({
  enabled: `${ENTRY}.enabled`,
  vaultMode: `${ENTRY}.config.vaultMode`,
  vaultPath: `${ENTRY}.config.vault.path`,
});

export type WiringConflict =
  | "plugin-disabled"
  | "plugin-denied"
  | "plugin-not-allowed"
  | "other-vault-mode"
  | "other-vault-path"
  | "agent-scope";

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
   * Resolve the conflicts that ONLY need our three keys: a disabled plugin, a
   * different mode or a different vault path. A deny/allow list and agent
   * scope are never edited from here — they say something about the whole
   * box, not about this vault.
   */
  force?: boolean;
}

export type WiringResult = WiringPlan & { wrote: boolean };

const FORCEABLE: ReadonlySet<WiringConflict> = new Set(["plugin-disabled", "other-vault-mode", "other-vault-path"]);

/** Make the plugin read the vault. One batched config write, or none. */
export async function ensureMemoryWikiWiring(options: EnsureWiringOptions = {}): Promise<WiringResult> {
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
