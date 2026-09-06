import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

import { getActiveHarness, type Harness } from "@/lib/harness";
import { canonicalPluginId, pluginHasSettingsRow, ROW_PLUGIN_IDS } from "@/lib/plugin-repair-id";

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

/**
 * Which step failed. The Retry re-runs exactly that step.
 *
 * `not-installed` is the third one (TASK-738), and it is the only one ClawBox
 * did not attempt: the core reports the entry as `plugin not installed: <id>`
 * in `openclaw config validate --json`, for a plugin an older core BUNDLED and
 * the installed one does not. Nothing ever installed it, so there is no failed
 * install to retry — what the row records is that the entry was switched OFF so
 * the gateway could report ready, and the package the core itself names for
 * anyone who wants it back.
 */
export type PluginRepairStage = "install" | "consent" | "not-installed";

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
  /**
   * The spec the boot script actually installs, when the failure was an
   * install: `@openclaw/codex@<pinned core>`, or
   * `clawhub:@openclaw/deepseek-provider@<release>`. Empty for a consent
   * failure, which installs nothing.
   *
   * NOT derivable from the id, which is the whole reason it is recorded. A
   * Retry that ran `plugins install codex` would resolve `@latest`, drift ahead
   * of the pinned runtime and crash every Codex chat — the bug the pin exists
   * to prevent — and `plugins install deepseek` names no ClawHub scheme at all.
   */
  spec: string;
}

export type PluginRepairs = Record<string, PluginRepairEntry>;

function parseEntry(key: string, raw: unknown): PluginRepairEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const stage: PluginRepairStage | null =
    r.stage === "install" || r.stage === "consent" || r.stage === "not-installed"
      ? r.stage
      : null;
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
  const spec = typeof r.spec === "string" ? r.spec.trim() : "";
  return { id, stage, reason, atMs, disabled: r.disabled === true, spec };
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
  // Nothing writes this on Hermes — it has no plugins of this kind and no
  // pre-start script that installs them — but a DUAL box runs both harnesses
  // out of one checkout, so the file can be there while OpenClaw is the idle
  // half. A "Needs repair" badge then describes a harness that is not running,
  // over a Retry that can only answer 404. Asked once, here, so no reader has
  // to remember it.
  if ((await getActiveHarness().catch(() => "openclaw" as Harness)) === "hermes") return {};
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

/** One row, as a caller states it. `atMs` is stamped here, not passed in. */
export type PluginRepairRecord = Omit<PluginRepairEntry, "atMs">;

/**
 * Record — or update — one plugin's repair row from the SERVER side.
 *
 * The mirror of `scripts/gateway-pre-start.sh`'s `clawbox_plugin_repair_mark`,
 * and deliberately the same file with the same shape: the boot script writes it
 * when IT could not install or consent a plugin, and the updater writes it when
 * the core reports an entry as never installed on a core the update has just
 * put on the box (TASK-738). One record, one reader, one Retry.
 *
 * A file that EXISTS and cannot be read is a THROW, not an empty map — the
 * distinction `readPluginRepairs` deliberately does not make, because its
 * wrong answer costs a missing badge while this one would rewrite the file and
 * discard every other plugin's row. A file that is absent or unparseable is an
 * empty map, exactly as the boot script treats it.
 *
 * Temp file plus rename in the same directory, so no reader ever sees half a
 * file, and the same `pid + uuid` name as the clear: two writes in flight
 * inside one process must not stage over each other.
 */
export async function recordPluginRepair(row: PluginRepairRecord): Promise<void> {
  const target = pluginRepairPath();
  let rows: Record<string, unknown> = {};
  let raw: string | null = null;
  try {
    raw = await fs.readFile(target, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows = parsed as Record<string, unknown>;
      }
    } catch {
      // Same as the boot script: an unparseable file is started over.
    }
  }
  rows[row.id] = { ...row, atMs: Date.now() };
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, target);
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
  // MATCHED ON THE CANONICAL ID, not on the literal key. The boot script marks
  // the plugin under the key openclaw.json carries — `@openclaw/discord` when
  // `ensureChannelPlugin` enabled that spelling, `@openclaw/deepseek-provider`
  // for the provider — while every caller here knows it by its bare name. An
  // exact lookup answered `false` and left the "Needs repair" badge up on
  // exactly the row it describes. `repairFor` above already reads it this way;
  // the two now agree.
  const wanted = canonicalPluginId(id);
  const keys = Object.keys(current).filter((key) => canonicalPluginId(current[key].id) === wanted);
  if (keys.length === 0) return false;
  for (const key of keys) delete current[key];
  const target = pluginRepairPath();
  // The pid alone is not unique WITHIN a process: two clears in flight at once
  // would stage over each other and one rename would land a file the other was
  // still writing.
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, target);
  return true;
}

/**
 * The CONFIGURED key of an entry ClawBox itself switched off, or null.
 *
 * `openclaw plugins install` deliberately leaves an entry whose
 * `plugins.entries.<id>.enabled` is explicitly `false` alone — which is exactly
 * what the boot script's boot-without wrote — so an install that succeeded is
 * not yet a plugin that loads. Every caller that clears a marker after an
 * INSTALL has to put the entry back first, and it needs the key the row was
 * written under to do it.
 *
 * `disabled: false` answers null: that row records a failure over which nothing
 * was changed, and an entry the OWNER turned off is his to turn back on.
 */
export async function clawboxDisabledEntryId(id: string): Promise<string | null> {
  const wanted = canonicalPluginId(id);
  const rows = await readPluginRepairs();
  const row = Object.values(rows).find(
    (entry) => canonicalPluginId(entry.id) === wanted && entry.disabled,
  );
  return row ? row.id : null;
}

/** The repair entry for a provider or channel row id, or null. */
export function repairFor(repairs: PluginRepairs, rowId: string): PluginRepairEntry | null {
  const wanted = ROW_PLUGIN_IDS[rowId];
  if (!wanted) return null;
  for (const entry of Object.values(repairs)) {
    if (canonicalPluginId(entry.id) === wanted) return entry;
  }
  return null;
}

// Re-exported so the server-side callers keep one import.
export { canonicalPluginId, ROW_PLUGIN_IDS, pluginHasSettingsRow };
