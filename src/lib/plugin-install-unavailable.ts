import { randomUUID } from "crypto";
// Named, not the default export: the updater's suite replaces `fs/promises`
// with a two-function mock that has no default, and it runs this reader for real.
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path, { untraced } from "@/lib/runtime-path";

// A plugin release the registry does not have for THIS core (TASK-1206).
//
// The 4.1.0 box: OpenClaw 2026.9.4, and ClawHub has no
// `@openclaw/deepseek-provider@2026.9.4` — its catalogue goes 2026.9.3 →
// 2026.9.5 (npm has every release; ClawHub skipped this one). The unpinned
// fallback resolves ClawHub's latest, whose manifest wants plugin API
// `>=2026.9.5`, and the 2026.9.4 runtime refuses it. Both answers are the
// registry's own and neither changes between two starts of the same core — yet
// every gateway start asked both again, waited 35–60 s on a Jetson, switched
// the plugin off, filed "Needs repair" and carried on.
//
// This is the NEGATIVE result, kept so the next start does not ask again:
//
//   PER CORE. A different core is a different question — the pinned spec is
//   the core's own version — so a record for another core counts for nothing.
//   BOUNDED. A week at most, so a registry that catches up (a late publish, a
//   backfill) is picked up without anyone pressing anything; the next ClawBox
//   update that moves the core pin asks again at once.
//   ONLY WHAT THE REGISTRY SAID. A timeout, a DNS failure or a 503 is not an
//   answer about the package and is never recorded: those keep the old
//   ask-again-at-every-start behaviour, because the next start may succeed.
//
// Written by `scripts/gateway-pre-start.sh` (the boot path) and by
// `installDeepseekProviderPlugin` (the configure route, the Retry, the
// updater); read by both and by the updater's after-update retry. Same file,
// same shape, both sides — the shell copy of the pattern below is held to this
// one by `plugin-install-unavailable.test.ts`.

/** How long a "no installable build" answer is believed without asking again. */
export const PLUGIN_INSTALL_UNAVAILABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The registry's and the core's own words for "there is no build this core
 * can load" — and nothing that a retry could change:
 *
 *   `Version not found on ClawHub` / `Package not found on ClawHub.` — the core's
 *     ClawHub installer on a 404;
 *   `Package not found on npm` / `E404` / `is not in this registry` /
 *     `ETARGET` / `No matching version` / `notarget` — npm's;
 *   `requires plugin API >=X, but this OpenClaw runtime exposes Y` and
 *     `requires OpenClaw >=X` — the core refusing a build made for a newer one.
 */
export const NO_INSTALLABLE_BUILD_PATTERN =
  "Version not found|Package not found|not in this registry|E404|ETARGET|No matching version|notarget|requires plugin API|requires OpenClaw";

const NO_INSTALLABLE_BUILD_RE = new RegExp(NO_INSTALLABLE_BUILD_PATTERN, "i");

/**
 * Does this refusal say the build does not exist, or does not fit the core?
 *
 * A KILLED install is never that answer, whatever it printed before it died:
 * the verb did not finish, so its verdict is unknown.
 */
export function saysNoInstallableBuild(text: string): boolean {
  if (/timed out after|killed at its deadline|ETIMEDOUT/i.test(text)) return false;
  return NO_INSTALLABLE_BUILD_RE.test(text);
}

/**
 * `$CLAWBOX_ROOT/data/plugin-install-unavailable.json`, beside the repair
 * record and resolved the same way `pluginRepairPath` resolves that one — from
 * the environment, not through `config-store` (see the reason given there).
 */
export function pluginInstallUnavailablePath(): string {
  const root = process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  return path.join(root, "data", "plugin-install-unavailable.json");
}

export interface PluginInstallUnavailable {
  /** The core release the registry was asked for. */
  core: string;
  /** When it last answered "no". */
  atMs: number;
  /** Every spec that was tried, in order. */
  specs: string[];
  /** One line in the core's words, for the boot log and the update log. */
  cause: string;
}

type Records = Record<string, PluginInstallUnavailable>;

function isRecord(value: unknown): value is PluginInstallUnavailable {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.core === "string" && typeof row.atMs === "number" && Number.isFinite(row.atMs);
}

async function readRecords(): Promise<Records> {
  let raw: string;
  try {
    raw = await readFile(pluginInstallUnavailablePath(), "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Records : {};
  } catch {
    // A torn cache is an empty cache: the worst it costs is one more ask.
    return {};
  }
}

async function writeRecords(records: Records): Promise<void> {
  const target = pluginInstallUnavailablePath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = untraced(`${target}.tmp.${process.pid}.${randomUUID()}`);
  try {
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf-8");
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * The record for this plugin on THIS core, or null when there is none worth
 * believing: another core's, older than the bound — or stamped more than the
 * bound in the future, which is a clock that was wrong when it was written and
 * would otherwise hold for ever.
 */
export async function readPluginInstallUnavailable(
  pluginId: string,
  release: string,
  nowMs: number = Date.now(),
): Promise<PluginInstallUnavailable | null> {
  const row = (await readRecords())[pluginId];
  if (!isRecord(row) || row.core !== release) return null;
  if (Math.abs(nowMs - row.atMs) >= PLUGIN_INSTALL_UNAVAILABLE_TTL_MS) return null;
  return {
    core: row.core,
    atMs: row.atMs,
    specs: Array.isArray(row.specs) ? row.specs.filter((spec): spec is string => typeof spec === "string") : [],
    cause: typeof row.cause === "string" ? row.cause : "",
  };
}

/** Best effort: a cache that cannot be written costs one more ask, never a failure. */
export async function recordPluginInstallUnavailable(
  pluginId: string,
  record: PluginInstallUnavailable,
): Promise<void> {
  try {
    const records = await readRecords();
    records[pluginId] = record;
    await writeRecords(records);
  } catch (err) {
    console.warn(
      `[plugins] could not record that ${pluginId} has no installable build for OpenClaw ${record.core}; the next attempt asks the registry again:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** The plugin installed after all: the "no" is history. Best effort, like the write. */
export async function forgetPluginInstallUnavailable(pluginId: string): Promise<void> {
  try {
    const records = await readRecords();
    if (!(pluginId in records)) return;
    delete records[pluginId];
    await writeRecords(records);
  } catch {
    // The next record for this core replaces it; a stale one expires on its own.
  }
}
