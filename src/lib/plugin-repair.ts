import { randomUUID } from "crypto";
import fs from "fs/promises";
import path, { untraced } from "@/lib/runtime-path";

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
  /**
   * One line, from the boot script, for the owner to read.
   *
   * ClawBox's own sentence about the CONSEQUENCE ("the gateway would refuse to
   * start with it enabled") and, since TASK-785, the core's own words about the
   * CAUSE after it: the exit code of the verb that failed and one trimmed line
   * of what it said. A row that carried only the first half stood on a box for
   * three days saying what would have happened and nothing about why, over a
   * failure that turned out to be transient. The boot script collapses the
   * CLI's answer to one line of at most 160 characters (`clawbox_plugin_cli_cause`)
   * because every renderer of this field prints it verbatim beside a Retry.
   * It is the core's English, not a translated string — the same as every other
   * sentence the boot script writes into this field.
   */
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
   * The spec the boot script would install: `@openclaw/codex@<pinned core>`,
   * `@openclaw/discord@<installed core>`, or
   * `clawhub:@openclaw/deepseek-provider@<release>`.
   *
   * RECORDED FOR A CONSENT ROW TOO since TASK-785, though a consent Retry does
   * not install anything. A consent failure and a missing payload are the same
   * refusal from the outside — `plugins enable` answers the second with "Plugin
   * not found" — so a row filed as `consent` with no spec could never be
   * re-filed as the install it actually needs, and the Retry it offered ran the
   * verb that had just refused. Empty only where ClawBox owns no package for
   * the id (`clawbox-email-directives`, which is copied out of the checkout)
   * or where the pinned release could not be read. A writer that cannot build
   * the spec never ERASES one the row already carries: `deepseek`'s ClawHub
   * scheme is known only to its own block, and the boot re-attempt refiles that
   * row without it.
   *
   * NOT derivable from the id, which is the whole reason it is recorded. A
   * Retry that ran `plugins install codex` would resolve `@latest`, drift ahead
   * of the pinned runtime and crash every Codex chat — the bug the pin exists
   * to prevent — and `plugins install deepseek` names no ClawHub scheme at all.
   *
   * NOT ALWAYS PINNED, and deliberately so for the `not-installed` stage: what
   * the core names in `plugin not installed: <id> — install … with: openclaw
   * plugins install @openclaw/<pkg>` is the catalogue's own unversioned
   * `npmSpec`, because these provider packages are versioned independently of
   * the core (unlike `@openclaw/codex`). A pin invented here would be a
   * version this repo made up; the core's own install-time host-version check
   * is what refuses a build that does not fit.
   */
  spec: string;
  /**
   * The core release the automatic after-update retry has been spent on
   * (TASK-1088), absent until one has run.
   *
   * THE BOUND on that retry. A core update strands exactly these rows — the
   * 2026.9.3 → 2026.9.4 box showed both ChatGPT and ClawBox AI as "Needs repair"
   * over failures recorded against the older core — so the updater retries each
   * row ClawBox switched off once per core it installs, and this is the record
   * that it did. A second run on the same core (a resumed update, a re-run)
   * finds it and does nothing; the next core bump retries again. Every writer
   * that re-files a row keeps it, like `spec`: a boot that fails the same row
   * again has not given it the after-update retry.
   */
  retriedCore?: string;
  /**
   * Set while a repair of this row is RUNNING — the owner's Retry or the
   * updater's after-update retry — and gone when it ends, epoch ms.
   *
   * So the panel can tell the truth in between: "Repairing…" rather than a
   * Retry that would start a second install over the first. Read through
   * `pluginRepairInProgress`, which ignores a stamp older than
   * `PLUGIN_REPAIR_IN_PROGRESS_MS`: a web server killed mid-repair must not
   * leave a row saying "Repairing…" for ever. Every re-file drops it, because a
   * re-file is the end of an attempt.
   */
  repairingSinceMs?: number;
}

export type PluginRepairs = Record<string, PluginRepairEntry>;

/**
 * How long a `repairingSinceMs` stamp is believed.
 *
 * Longer than the slowest repair either writer runs — an install (180 s), a
 * runtime inspect (120 s), an enable and a gateway restart, twice over for the
 * two plugins the updater may retry together — and short enough that a stamp
 * left behind by a killed process gives the Retry back within the same sitting.
 */
export const PLUGIN_REPAIR_IN_PROGRESS_MS = 20 * 60_000;

/** Is a repair of this row running right now, by its own stamp? */
export function pluginRepairInProgress(entry: PluginRepairEntry, nowMs: number = Date.now()): boolean {
  const since = entry.repairingSinceMs;
  return typeof since === "number" && since <= nowMs && nowMs - since < PLUGIN_REPAIR_IN_PROGRESS_MS;
}

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
  const entry: PluginRepairEntry = { id, stage, reason, atMs, disabled: r.disabled === true, spec };
  // Both optional, and only carried when they are what they say: a row written
  // before TASK-1088 has neither, and reads exactly as it always did.
  if (typeof r.retriedCore === "string" && r.retriedCore.trim()) entry.retriedCore = r.retriedCore.trim();
  if (typeof r.repairingSinceMs === "number" && Number.isFinite(r.repairingSinceMs)) {
    entry.repairingSinceMs = r.repairingSinceMs;
  }
  return entry;
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
 * EVERY WRITER HOLDS THE STORE'S LOCK (`withPluginRepairLock`) for its whole
 * read-modify-write — the boot script, the updater, the owner's Retry, and the
 * two routes that clear a row after a repair of their own. "Only one pair can
 * overlap" was the old argument for going without, and TASK-1088 made it false:
 * the Retry and the after-update retry both stamp a row the gateway's own
 * pre-start may be re-filing in the same second, and last writer wins lost rows.
 *
 * A file that EXISTS and cannot be read is a THROW, not an empty map — the
 * distinction `readPluginRepairs` deliberately does not make, because its
 * wrong answer costs a missing badge while this one would rewrite the file and
 * discard every other plugin's row. A file that is absent is an empty map; one
 * that is damaged keeps every row that can still be read, and is itself kept
 * beside the store (`readRowsForUpdate`) — exactly as the boot script treats it.
 *
 * Temp file plus rename in the same directory, so no reader ever sees half a
 * file, and the same `pid + uuid` name as the clear: two writes in flight
 * inside one process must not stage over each other.
 */
export async function recordPluginRepair(row: PluginRepairRecord): Promise<void> {
  await withPluginRepairLock(() => recordPluginRepairLocked(row));
}

async function recordPluginRepairLocked(row: PluginRepairRecord): Promise<void> {
  const target = pluginRepairPath();
  // Salvaged, not started over, when the file is damaged (TASK-1198) — see
  // `readRowsForUpdate`. Starting over was the boot script's rule too, and it
  // turned one torn write into a store holding only the row being filed.
  const rows = await readRowsForUpdate(target);
  // AN EMPTY SPEC NEVER ERASES ONE THE ROW ALREADY CARRIES, the same rule
  // `clawbox_plugin_repair_mark` follows in the boot script (TASK-785). Each id
  // had one writer while this was safe; the boot re-attempt made a second, and
  // a caller that cannot build the spec would otherwise wipe the string the
  // Retry needs. A re-file changes the stage, never which package it is.
  const previous = rows[row.id];
  const previousRow = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as { spec?: unknown; retriedCore?: unknown }
    : {};
  const spec = row.spec || (typeof previousRow.spec === "string" ? previousRow.spec : "");
  // THE AFTER-UPDATE RETRY IS KEPT the same way (TASK-1088): a re-file by
  // another writer has not given this row that retry, and dropping the record
  // would buy it a second one on the same core. The in-progress stamp is the
  // opposite — a re-file is the END of an attempt — so it is never carried.
  const retriedCore = row.retriedCore
    || (typeof previousRow.retriedCore === "string" ? previousRow.retriedCore : undefined);
  const next: Record<string, unknown> = { ...row, spec, atMs: Date.now() };
  delete next.repairingSinceMs;
  if (retriedCore) next.retriedCore = retriedCore;
  else delete next.retriedCore;
  rows[row.id] = next;
  await writeRowsAtomically(target, rows);
}

/**
 * Read the file for a write that must not lose other rows — every writer here
 * reads through this. A file that EXISTS and cannot be read throws; an absent
 * one is an empty map; a DAMAGED one is recovered as far as it can be.
 *
 * DAMAGED IS NOT EMPTY (TASK-1198). Every writer used to read an unparseable
 * file as `{}` and write its one row over it, so a single torn write — a
 * power cut between the boot script's write and the disk, a full `data/` —
 * silently became a store that knew about one plugin, and every other plugin
 * ClawBox had switched off lost its "Needs repair" row and with it the only
 * record that it was ClawBox, not the owner, that turned it off. Now:
 *
 *  - the rows before the damage are kept (`salvagePluginRepairRows`), which is
 *    all of them for the torn-write case, where the damage is a cut-off end;
 *  - the damaged file is kept beside the store as `plugin-repair.json.corrupt`
 *    before anything is written over it, so what could not be salvaged is still
 *    on the box for whoever looks into it; one file, overwritten, so a box
 *    that keeps tearing it does not fill `data/`;
 *  - and it is SAID, in the server log.
 *
 * The boot script's writer (`clawbox_plugin_repair_mark`) follows the same
 * rule, so neither writer can undo the other's recovery.
 */
async function readRowsForUpdate(target: string): Promise<Record<string, unknown>> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw err;
  }
  // A byte that is not UTF-8 becomes U+FFFD, exactly as the boot script's
  // `decode("utf-8", errors="replace")` reads it.
  const raw = bytes.toString("utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  const rows = salvagePluginRepairRows(raw);
  const kept = pluginRepairCorruptPath();
  let keptNote = `the damaged file is kept as ${kept}`;
  try {
    // Byte for byte: this copy is for whoever looks into the damage.
    await fs.writeFile(kept, bytes, { mode: 0o600 });
  } catch (err) {
    keptNote = `the damaged file could not be kept (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`;
  }
  console.warn(
    `[plugin-repair] ${target} is damaged; recovered ${Object.keys(rows).length} row(s) from it and ${keptNote}`,
  );
  return rows;
}

/** Where a damaged store is kept before a writer replaces it. */
export function pluginRepairCorruptPath(): string {
  return untraced(`${pluginRepairPath()}.corrupt`);
}

/**
 * The rows a damaged `plugin-repair.json` still holds: every top-level member,
 * in order, up to the first one that does not parse, keeping those whose value
 * is an object. `{}` for anything that does not even open as an object.
 *
 * A PREFIX, deliberately, and the same prefix the boot script's
 * `json.JSONDecoder.raw_decode` walk recovers. The realistic damage is a
 * truncated file, where the prefix is everything that was written; guessing
 * where a row resumes after garbage in the middle could only invent rows, and
 * an invented row here is a Retry that installs something.
 */
export function salvagePluginRepairRows(raw: string): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  let i = skipJsonSpace(raw, 0);
  if (raw.charCodeAt(i) === 0xfeff) i = skipJsonSpace(raw, i + 1);
  if (raw[i] !== "{") return rows;
  i += 1;
  for (;;) {
    i = skipJsonSpace(raw, i);
    if (raw[i] === ",") i = skipJsonSpace(raw, i + 1);
    // The closing brace, the end of a cut-off file, or damage: all end the walk.
    if (raw[i] !== "\"") return rows;
    const keyEnd = jsonValueEnd(raw, i);
    if (keyEnd < 0) return rows;
    let key: unknown;
    try {
      key = JSON.parse(raw.slice(i, keyEnd));
    } catch {
      return rows;
    }
    i = skipJsonSpace(raw, keyEnd);
    if (raw[i] !== ":") return rows;
    i = skipJsonSpace(raw, i + 1);
    const valueEnd = jsonValueEnd(raw, i);
    if (valueEnd < 0) return rows;
    let value: unknown;
    try {
      value = JSON.parse(raw.slice(i, valueEnd));
    } catch {
      return rows;
    }
    if (typeof key === "string" && value && typeof value === "object" && !Array.isArray(value)) {
      rows[key] = value;
    }
    i = valueEnd;
  }
}

function skipJsonSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i += 1;
  return i;
}

/**
 * Where the JSON value starting at `start` ends — exclusive — or -1 when the
 * text runs out first. Only finds the extent; `JSON.parse` on the slice is
 * what decides whether it is a value.
 */
function jsonValueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === undefined) return -1;
  if (first !== "\"" && first !== "{" && first !== "[") {
    let i = start;
    while (i < text.length && !",}] \n\r\t".includes(text[i])) i += 1;
    return i;
  }
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === "\"") {
        inString = false;
        if (depth === 0) return i + 1;
      }
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Say that a repair of this row has started (`true`) or ended (`false`),
 * without touching anything else on it — `atMs` above all, which is what
 * `clearPluginRepairUnlessRefiled` compares against. Answers whether a row was
 * there to stamp. Matched on the canonical id, like every reader.
 *
 * `retriedCore` spends the after-update retry in the SAME write that starts it
 * (TASK-1088): a process killed mid-repair has still had its one attempt on
 * that core, which is what keeps the retry bounded rather than once per crash.
 */
export async function setPluginRepairInProgress(
  id: string,
  running: boolean,
  options: { retriedCore?: string } = {},
): Promise<boolean> {
  return withStampLock(() => withPluginRepairLock(async () => {
    const outcome = await stampRows(id, running, options, { onlyWhenIdle: false });
    return outcome !== "absent";
  }));
}

/**
 * Check that no repair of this row is running AND stamp it as running, as ONE
 * step (TASK-1088). The Retry route and the updater's after-update retry live
 * in the same server process, and "read the row, see no stamp, write a stamp"
 * as two steps let two presses — or a press under the after-update retry —
 * both pass the check and both run `plugins install --force` over each other.
 * The read-check-write runs under the store's CROSS-PROCESS lock, so exactly
 * one caller gets `claimed` wherever it runs; the others get `busy` without
 * having written anything.
 *
 * Not in-process only: the updater and the web server are separate processes,
 * and the boot script re-files the same rows from a third — a gateway start
 * that another press or update may have triggered — so the in-process turn
 * below only saves same-process callers from polling the lock file.
 */
export async function claimPluginRepair(
  id: string,
  options: { retriedCore?: string } = {},
): Promise<"claimed" | "busy" | "absent"> {
  return withStampLock(() => withPluginRepairLock(() => stampRows(id, true, options, { onlyWhenIdle: true })));
}

let stampTurn: Promise<unknown> = Promise.resolve();

/**
 * One stamp at a time inside this process; a failed one does not poison the
 * next. A supplement to `withPluginRepairLock`, never a replacement for it.
 */
function withStampLock<T>(operation: () => Promise<T>): Promise<T> {
  const turn = stampTurn.then(operation, operation);
  stampTurn = turn.catch(() => undefined);
  return turn;
}

async function stampRows(
  id: string,
  running: boolean,
  options: { retriedCore?: string },
  guard: { onlyWhenIdle: boolean },
): Promise<"claimed" | "busy" | "absent"> {
  const target = pluginRepairPath();
  const rows = await readRowsForUpdate(target);
  const wanted = canonicalPluginId(id);
  let touched = false;
  for (const [key, value] of Object.entries(rows)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const rowId = typeof row.id === "string" && row.id.trim() ? row.id.trim() : key;
    if (canonicalPluginId(rowId) !== wanted) continue;
    if (running) {
      if (guard.onlyWhenIdle) {
        const parsed = parseEntry(key, row);
        if (parsed && pluginRepairInProgress(parsed)) return "busy";
      }
      row.repairingSinceMs = Date.now();
      if (options.retriedCore) row.retriedCore = options.retriedCore;
    } else if ("repairingSinceMs" in row) {
      delete row.repairingSinceMs;
    } else {
      continue;
    }
    touched = true;
  }
  if (!touched) return "absent";
  await writeRowsAtomically(target, rows);
  return "claimed";
}

/**
 * How long a lock on the store is believed. Every holder keeps it for ONE
 * read-modify-write of a small JSON file — milliseconds — so a lock this old
 * was left by a writer that died holding it, and is taken over rather than
 * waited out. `scripts/gateway-pre-start.sh` uses the same age.
 */
const PLUGIN_REPAIR_LOCK_STALE_MS = 10_000;

/** How long a writer waits for it: past the stale age, so a dead holder's lock is always reached. */
const PLUGIN_REPAIR_LOCK_WAIT_MS = 15_000;

/** The store's cross-process lock, beside it. */
export function pluginRepairLockPath(): string {
  return untraced(`${pluginRepairPath()}.lock`);
}

/**
 * Run one read-modify-write of the store under its CROSS-PROCESS lock.
 *
 * The web server, the updater and `scripts/gateway-pre-start.sh` are separate
 * processes writing one file, so a module mutex cannot order them. The lock is
 * `plugin-repair.json.lock`, created `O_EXCL` with an owner token and removed
 * only while the token is still ours — the protocol the boot script's
 * `clawbox_plugin_repair_locked` follows too, so the two exclude each other.
 * Not reentrant: nothing that holds it calls another writer here.
 */
async function withPluginRepairLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPath = pluginRepairLockPath();
  const token = `${process.pid}.${randomUUID()}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + PLUGIN_REPAIR_LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(lockPath, "wx", 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    if (handle) {
      try {
        await handle.writeFile(`${token}\n`, "utf-8");
      } catch (err) {
        // Ours — `O_EXCL` says so — and no use to anyone without its token.
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
        throw err;
      }
      await handle.close().catch(() => {});
      break;
    }
    if (await reclaimStalePluginRepairLock(lockPath) && Date.now() < deadline) continue;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for the plugin repair lock ${lockPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, 20 + 10 * attempt)));
  }
  try {
    return await operation();
  } finally {
    // Only while it is still OURS: a lock taken over as stale is its new holder's.
    const held = await fs.readFile(lockPath, "utf-8").catch(() => null);
    if (held?.trim() === token) await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * Take over a lock its holder died with, and answer whether the way is clear.
 *
 * Re-checked under a `.reclaim` guard directory, so two waiters that both saw
 * the same dead lock cannot take it over in turn — the second deleting the live
 * lock the first has just made. The guard is held for a stat and an unlink; one
 * older than the stale age was left by a waiter that died as well.
 */
async function reclaimStalePluginRepairLock(lockPath: string): Promise<boolean> {
  const observed = await fs.lstat(lockPath).catch(() => null);
  if (!observed) return true;
  if (Date.now() - observed.mtimeMs < PLUGIN_REPAIR_LOCK_STALE_MS) return false;
  const guard = `${lockPath}.reclaim`;
  try {
    await fs.mkdir(guard);
  } catch {
    const held = await fs.lstat(guard).catch(() => null);
    if (held && Date.now() - held.mtimeMs >= PLUGIN_REPAIR_LOCK_STALE_MS) {
      await fs.rmdir(guard).catch(() => {});
    }
    return false;
  }
  try {
    const current = await fs.lstat(lockPath).catch(() => null);
    if (!current) return true;
    if (current.ino !== observed.ino || current.dev !== observed.dev
      || Date.now() - current.mtimeMs < PLUGIN_REPAIR_LOCK_STALE_MS) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } finally {
    await fs.rmdir(guard).catch(() => {});
  }
}

/**
 * Stage the whole file beside itself and rename it into place.
 *
 * Temp file plus rename in the same directory, so no reader ever sees half a
 * file; `pid + uuid` because two writes in flight inside one process must not
 * stage over each other. AND the temp is removed when the rename fails, the
 * way the boot script's writer already does it: a full `data/` partition or a
 * read-only remount would otherwise leave one `plugin-repair.json.tmp.*` per
 * attempt, for ever, on exactly the box that can least afford them.
 */
async function writeRowsAtomically(target: string, rows: unknown): Promise<void> {
  const tmp = untraced(`${target}.tmp.${process.pid}.${randomUUID()}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
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
  // Every channel enable and provider save calls this, and on a healthy box
  // there is no row: that answer is a read, not a read-modify-write, and costs
  // no lock. A row that is there is looked for again under it.
  const wanted = canonicalPluginId(id);
  if (!Object.values(await readPluginRepairs()).some((row) => canonicalPluginId(row.id) === wanted)) return false;
  return withPluginRepairLock(() => clearPluginRepairLocked(id));
}

async function clearPluginRepairLocked(id: string): Promise<boolean> {
  if (await hermesIsActive()) return false;
  const target = pluginRepairPath();
  const rows = await readRowsForUpdate(target);
  // MATCHED ON THE CANONICAL ID, not on the literal key. The boot script marks
  // the plugin under the key openclaw.json carries — `@openclaw/discord` when
  // `ensureChannelPlugin` enabled that spelling, `@openclaw/deepseek-provider`
  // for the provider — while every caller here knows it by its bare name. An
  // exact lookup answered `false` and left the "Needs repair" badge up on
  // exactly the row it describes. `repairFor` above already reads it this way;
  // the two now agree.
  const keys = rowsFor(rows, id).map(({ key }) => key);
  if (keys.length === 0) return false;
  // Only the matched keys go, and every OTHER row is written back exactly as
  // it was read (TASK-1198) — not as the reader's filtered copy, which dropped
  // a row this build cannot parse (a stage a newer boot script files) and
  // every field it does not know.
  for (const key of keys) delete rows[key];
  await writeRowsAtomically(target, rows);
  return true;
}

/** Hermes is the running harness: nothing here describes it (`readPluginRepairs`). */
async function hermesIsActive(): Promise<boolean> {
  return (await getActiveHarness().catch(() => "openclaw" as Harness)) === "hermes";
}

/** The rows the READER would show for this plugin, with the keys they sit under in the raw store. */
function rowsFor(rows: Record<string, unknown>, id: string): { key: string; entry: PluginRepairEntry }[] {
  const wanted = canonicalPluginId(id);
  const out: { key: string; entry: PluginRepairEntry }[] = [];
  for (const [key, value] of Object.entries(rows)) {
    const entry = parseEntry(key, value);
    if (entry && canonicalPluginId(entry.id) === wanted) out.push({ key, entry });
  }
  return out;
}

/**
 * `clearPluginRepair`, unless somebody FILED THE ROW AGAIN while the repair ran.
 *
 * TASK-1088. Both repairs end in a gateway restart, and the restart runs
 * `scripts/gateway-pre-start.sh`, which asks the core about this very plugin
 * and — when the answer is still no — switches it off again and re-files the
 * row with a fresh `atMs` and the cause. A clear by id after that deleted the
 * failure the boot script had just recorded: the badge went, the plugin stayed
 * off, and the Providers page said "connected" over a provider that could not
 * run. So the caller passes the `atMs` of the row it set out to repair, and a
 * row whose `atMs` has moved is left exactly as it is.
 *
 * `"absent"` is a success too: the boot script's own consent loop clears the
 * row itself when the restarted core confirms the plugin.
 */
export async function clearPluginRepairUnlessRefiled(
  id: string,
  atMs: number,
): Promise<"cleared" | "absent" | "refiled"> {
  return withPluginRepairLock(async () => {
    if (await hermesIsActive()) return "absent";
    const target = pluginRepairPath();
    const rows = await readRowsForUpdate(target);
    const matches = rowsFor(rows, id);
    if (matches.length === 0) return "absent";
    if (matches.some(({ entry }) => entry.atMs !== atMs)) return "refiled";
    for (const { key } of matches) delete rows[key];
    await writeRowsAtomically(target, rows);
    return "cleared";
  });
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
