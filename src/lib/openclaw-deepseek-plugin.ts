import { spawnOpenclawCli } from "./openclaw-config";
import {
  forgetPluginInstallUnavailable,
  readPluginInstallUnavailable,
  recordPluginInstallUnavailable,
  saysNoInstallableBuild,
} from "./plugin-install-unavailable";

/**
 * The DeepSeek provider plugin ClawBox AI rides on. OpenClaw 2 unbundled it
 * (`@openclaw/deepseek-provider` on ClawHub) and refuses gateway readiness
 * while a configured deepseek provider has no consented plugin behind it.
 *
 * NOT WHAT CARRIES ClawBox AI's TURNS (TASK-1206). The configure route writes
 * the `deepseek` provider as a full `api: "openai-completions"` definition —
 * base URL, key, models, reasoning efforts — so the core's own OpenAI-compatible
 * transport sends every turn, and a box whose plugin is switched off still
 * chats. What the plugin adds is DeepSeek's native hooks: the V4 thinking
 * wrapper and profile, reasoning replay, tool compatibility, usage. Worth
 * installing, never worth a gateway start that waits on a build the registry
 * does not have — see `plugin-install-unavailable.ts`.
 *
 * Installed PINNED to the running core, never `@latest`. The plugin is cut
 * from the openclaw/openclaw tree with the core's own version number, and
 * each release declares the plugin API it needs: the day 2026.8.2 shipped,
 * the unpinned spec resolved to a build wanting `>=2026.8.2`, the pinned
 * 2026.8.1 runtime refused it ("requires plugin API >=2026.8.2, but this
 * OpenClaw runtime exposes 2026.8.1") and every fresh install parked at a
 * gateway that would not report ready. `scripts/gateway-pre-start.sh` pins
 * the same way on the boot path; this is the copy the configure route uses
 * when it creates the deepseek provider in the first place.
 */
export const DEEPSEEK_PROVIDER_PLUGIN_SPEC = "clawhub:@openclaw/deepseek-provider";

/** The plugin's id — the key its repair row and its unavailability record are filed under. */
export const DEEPSEEK_PLUGIN_ID = "deepseek";

/** ClawHub resolve + install runs well past the 30 s default; the e2e container measured it. */
const INSTALL_TIMEOUT_MS = 180_000;

/**
 * The release of the INSTALLED core ("2026.8.1"), asked of the binary — it is
 * the process that will load the plugin, and it disagrees with the pin file
 * mid-update. Null when it cannot be asked.
 */
export async function installedOpenclawRelease(): Promise<string | null> {
  try {
    const out = await spawnOpenclawCli(["--version"], { timeoutMs: 10_000, captureStdout: true });
    return out.match(/20\d{2}\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The specs to try, in order: the build matching the core first, then the
 * unpinned spec as the fallback for a core with no plugin build of its own
 * version (so an unknown release still gets the old behaviour).
 */
export function deepseekPluginSpecs(release: string | null): string[] {
  return release
    ? [`${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@${release}`, DEEPSEEK_PROVIDER_PLUGIN_SPEC]
    : [DEEPSEEK_PROVIDER_PLUGIN_SPEC];
}

export interface DeepseekPluginInstallResult {
  /** The spec that installed, or null when none did. */
  installed: string | null;
  /** One line per spec that failed, in the order they were tried. */
  failures: string[];
  /**
   * True when no build this core can load exists — every spec was refused in
   * the registry's own words, now or at an attempt still on record — as
   * opposed to an install that failed for a reason a retry could change.
   */
  unavailable: boolean;
}

/**
 * Best effort: never throws — the caller's own write path names a missing plugin loudly.
 *
 * `force` is for a REPAIR (TASK-1088): after a core bump the old payload is
 * usually still on disk, and `plugins install` refuses to write over it
 * ("plugin already exists") without the flag. The configure route installs
 * only when the payload is absent, so it has no use for it.
 *
 * `recheckUnavailable` is the owner's Retry (TASK-1206). Everything else — the
 * configure route a person is waiting on, the updater — believes a "no build
 * for this core" still on record and asks nothing, because the registry would
 * answer the same thing a minute or more later.
 */
export async function installDeepseekProviderPlugin(
  options: { force?: boolean; recheckUnavailable?: boolean } = {},
): Promise<DeepseekPluginInstallResult> {
  const release = await installedOpenclawRelease();
  if (release && !options.recheckUnavailable) {
    const known = await readPluginInstallUnavailable(DEEPSEEK_PLUGIN_ID, release);
    if (known) {
      console.log(
        `[plugins] @openclaw/deepseek-provider has no installable build for OpenClaw ${release} on record; not asking the registry again`,
      );
      return {
        installed: null,
        failures: [`${known.specs[0] ?? DEEPSEEK_PROVIDER_PLUGIN_SPEC}: ${known.cause || "no installable build for this core"}`],
        unavailable: true,
      };
    }
  }
  const specs = deepseekPluginSpecs(release);
  const failures: string[] = [];
  let everyRefusalDefinitive = true;
  for (const spec of specs) {
    try {
      await spawnOpenclawCli(
        ["plugins", "install", spec, ...(options.force ? ["--force"] : []), "--accept-capabilities"],
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      await forgetPluginInstallUnavailable(DEEPSEEK_PLUGIN_ID);
      return { installed: spec, failures, unavailable: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!saysNoInstallableBuild(message)) everyRefusalDefinitive = false;
      failures.push(`${spec}: ${message}`);
    }
  }
  // Only a PINNED ask can be recorded: without the core's release there is
  // nothing to key the answer to, and the next core would inherit it.
  const unavailable = everyRefusalDefinitive && failures.length > 0;
  if (unavailable && release) {
    await recordPluginInstallUnavailable(DEEPSEEK_PLUGIN_ID, {
      core: release,
      atMs: Date.now(),
      specs,
      cause: oneLine(failures[0].slice(failures[0].indexOf(": ") + 2)),
    });
  }
  return { installed: null, failures, unavailable };
}

/** The last line that reads like a verdict, trimmed for a log line. */
function oneLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const picked = [...lines].reverse().find((line) => saysNoInstallableBuild(line)) ?? lines[lines.length - 1] ?? "";
  return picked.length > 160 ? `${picked.slice(0, 159).trimEnd()}…` : picked;
}
