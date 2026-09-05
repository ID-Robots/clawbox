import fs from "fs/promises";
import path from "path";

// What the boot script could not install or consent, and therefore switched off.
//
// WHY THIS FILE EXISTS (TASK-606, owner ruling 2026-09-03, option a). OpenClaw 2
// refuses gateway readiness for ANY enabled plugin whose declared surface has
// not been consented to. `scripts/gateway-pre-start.sh` installs and consents
// five of them, and when one of those steps failed it logged "gateway will
// still start" and carried on — which was not true: the gateway came up,
// refused readiness, was restarted by `Restart=always`, and burned the unit's
// `StartLimitBurst=20` in about fifteen minutes. Measured on a box: no agent
// and no Telegram for 46 minutes, and nothing running as `clawbox` clears a
// start limit at boot. The pre-v2 contract — "a degraded provider is better
// than a dead box" — had quietly become false.
//
// So the boot script now DISABLES the entry it could not make loadable and
// writes what happened here, and the box boots without that provider or
// channel. This file is that record: it is the only thing on the device that
// knows the difference between "the owner never asked for Discord" and "Discord
// is off because its plugin would not install this morning".
//
// HARNESS FIRST, and why the harness is not the reader. `openclaw plugins list
// --json` is the native answer to "is this plugin installed and consented", and
// the Retry below is nothing but the harness's own `plugins install` /
// `plugins enable` run again. But that CLI is a full Node program that loads the
// gateway SDK and validates the config on every run — about 8-10 s on an Orin —
// so it cannot back a Settings panel that polls. This marker is not a second
// copy of the harness's state: it is the BOOT SCRIPT's record of what it could
// not do, written by the only process that was there when it failed, and it is
// removed the moment the same step succeeds.
//
// BOTH EDITIONS. Hermes has no plugins in this sense and no pre-start script
// that installs them, so nothing ever writes this file there and every reader
// gets an empty map. That is inertness by construction rather than by an
// edition test: an absent file is not an error.

/**
 * Where the boot script writes it. One file, one owner.
 *
 * Resolved from the environment the way `scripts/gateway-pre-start.sh` resolves
 * `$CLAWBOX_ROOT/data/plugin-repair.json`, and deliberately NOT through
 * `config-store`'s `DATA_DIR`, which would otherwise be this module's only
 * import: 114 suites mock `@/lib/config-store` with just the keys they use, and
 * a module-scope `path.join(DATA_DIR, …)` throws at IMPORT time under such a
 * mock — so every route that transitively reaches this file would fail to load
 * in tests that have nothing to do with it. `plugin-repair-path.test.ts` holds
 * the two derivations to the same answer in a suite that mocks neither.
 *
 * A function rather than a constant, because a test sets `CLAWBOX_ROOT` and
 * re-imports; a constant frozen at first import would answer for the wrong box.
 */
export function pluginRepairPath(): string {
  const root = process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  return path.join(root, "data", "plugin-repair.json");
}

/** Which step failed. The Retry re-runs exactly that step. */
export type PluginRepairStage = "install" | "consent";

export interface PluginRepairEntry {
  /** The plugin id as `openclaw plugins` takes it — what Retry passes back. */
  id: string;
  stage: PluginRepairStage;
  /** One line, from the boot script, for the owner to read. Never a path. */
  reason: string;
  /** When the boot script gave up, epoch ms. */
  atMs: number;
  /**
   * True when the entry was switched off in openclaw.json as well, which is
   * what let the gateway boot. False when the plugin had no config entry to
   * switch off — an install that never got far enough to make one — in which
   * case the row still needs repair but nothing was changed on the owner's
   * behalf.
   */
  disabled: boolean;
}

export type PluginRepairs = Record<string, PluginRepairEntry>;

function parseEntry(key: string, raw: unknown): PluginRepairEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const stage = r.stage === "install" || r.stage === "consent" ? r.stage : null;
  if (!stage) return null;
  const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : null;
  if (!reason) return null;
  const atMs = typeof r.atMs === "number" && Number.isFinite(r.atMs) ? r.atMs : 0;
  // The RECORD's own id wins over the map key. The boot script writes the two
  // the same, but this id is what the Retry hands to `openclaw plugins`, and
  // reading it off the key would silently rewrite a spelling the harness needs
  // (`@openclaw/deepseek-provider` filed under `deepseek`) into one it may not
  // resolve. The key is the fallback for a row written before the field.
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : key;
  return { id, stage, reason, atMs, disabled: r.disabled === true };
}

/**
 * What still needs repair, or an empty map.
 *
 * EVERY failure answers `{}`: an absent file is the normal state, and a file
 * this process cannot read or parse is not evidence that something is broken.
 * The cost of the wrong answer runs one way only — a missing "Needs repair"
 * badge is a row that says "not connected", which is what it said before this
 * existed, while a badge invented from a parse error would send the owner
 * repairing a plugin that is fine.
 */
export async function readPluginRepairs(): Promise<PluginRepairs> {
  let raw: string;
  try {
    raw = await fs.readFile(pluginRepairPath(), "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: PluginRepairs = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = parseEntry(id, value);
    if (entry) out[id] = entry;
  }
  return out;
}

/**
 * Remove one plugin's entry, after its install or consent has been proved to
 * work again. Answers whether anything was removed.
 *
 * Written the way the boot script writes it — temp file plus rename in the same
 * directory — so a reader never sees half a file. An empty map leaves an empty
 * object rather than deleting the file: the boot script and this both open it
 * by name, and a delete would race a boot that is writing one.
 */
export async function clearPluginRepair(id: string): Promise<boolean> {
  const current = await readPluginRepairs();
  if (!current[id]) return false;
  delete current[id];
  const target = pluginRepairPath();
  const tmp = `${target}.tmp.${process.pid}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, target);
  return true;
}

/**
 * The bare name of a plugin, whatever spelling it arrived in.
 *
 * The registry keys one plugin under `discord`, `@openclaw/discord` and
 * `openclaw-discord` alike, and `ensureChannelPlugin` enables whichever one it
 * found — so a marker written under one spelling has to be found under any of
 * them, or the badge would be missing from exactly the row it describes.
 */
export function canonicalPluginId(id: string): string {
  let name = id;
  for (const prefix of ["@openclaw/", "openclaw-"]) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  // `@openclaw/deepseek-provider` is the DeepSeek provider plugin; the boot
  // script marks it as `deepseek`, which is also what `plugins enable` takes.
  return name.endsWith("-provider") ? name.slice(0, -"-provider".length) : name;
}

/**
 * Which plugin a Settings row depends on.
 *
 * Not an identity map, because two rows are named after the thing the owner
 * sees rather than after the plugin behind it: ClawBox AI rides the DeepSeek
 * provider on every paired box, and the OpenAI GPT row is served by the Codex
 * harness plugin. A row with no entry here has no plugin that can fail this
 * way, and is never badged.
 */
export const ROW_PLUGIN_IDS: Readonly<Record<string, string>> = {
  clawai: "deepseek",
  deepseek: "deepseek",
  openai: "codex",
  discord: "discord",
  whatsapp: "whatsapp",
};

/** The repair entry for a provider or channel row id, or null. */
export function repairFor(repairs: PluginRepairs, rowId: string): PluginRepairEntry | null {
  const wanted = ROW_PLUGIN_IDS[rowId];
  if (!wanted) return null;
  for (const entry of Object.values(repairs)) {
    if (canonicalPluginId(entry.id) === wanted) return entry;
  }
  return null;
}
