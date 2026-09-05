import { spawnOpenclawCli } from "./openclaw-config";
import { clearPluginRepair } from "./plugin-repair";

/**
 * The DeepSeek provider plugin ClawBox AI rides on. OpenClaw 2 unbundled it
 * (`@openclaw/deepseek-provider` on ClawHub) and refuses gateway readiness
 * while a configured deepseek provider has no consented plugin behind it.
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
}

/** Best effort: never throws — the caller's own write path names a missing plugin loudly. */
export async function installDeepseekProviderPlugin(): Promise<DeepseekPluginInstallResult> {
  const failures: string[] = [];
  for (const spec of deepseekPluginSpecs(await installedOpenclawRelease())) {
    try {
      await spawnOpenclawCli(["plugins", "install", spec, "--accept-capabilities"], {
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      // The plugin the boot script may have marked for repair is now installed,
      // whoever asked for it. A marker only the boot script cleared would leave
      // a "Needs repair" badge on the ClawBox AI row of a box that has just
      // been repaired from Settings (TASK-606).
      await clearPluginRepair("deepseek").catch(() => false);
      return { installed: spec, failures };
    } catch (err) {
      failures.push(`${spec}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { installed: null, failures };
}
