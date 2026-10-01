import fs from "fs/promises";

import path from "@/lib/runtime-path";

import { spawnOpenclawCli } from "./openclaw-config";

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
 * the same way on the boot path; this is the copy the configure route and the
 * Settings Retry use.
 */
export const DEEPSEEK_PROVIDER_PLUGIN_SPEC = "clawhub:@openclaw/deepseek-provider";

/**
 * The same package on npm (TASK-1302). ClawHub does not carry every release
 * npm does: it has no `@openclaw/deepseek-provider@2026.9.4` — the build the
 * 4.1 core needs — while npm has 2026.9.1 through 2026.9.6, and the package's
 * own `openclaw.install` names npm its `defaultChoice`. The unpinned ClawHub
 * fallback could not stand in for it either: it resolves `latest` (2026.9.6,
 * `pluginApi >=2026.9.6`), which the 2026.9.4 runtime refuses.
 */
export const DEEPSEEK_PROVIDER_NPM_SPEC = "npm:@openclaw/deepseek-provider";

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
 * The specs to try, in order — the same order `scripts/gateway-pre-start.sh`
 * walks: the build matching the core from ClawHub, the same build from npm
 * (for a release ClawHub never received), and only then the unpinned spec, for
 * a core with no plugin build of its own version anywhere (so an unknown
 * release still gets the old behaviour).
 */
export function deepseekPluginSpecs(release: string | null): string[] {
  return release
    ? [
      `${DEEPSEEK_PROVIDER_PLUGIN_SPEC}@${release}`,
      `${DEEPSEEK_PROVIDER_NPM_SPEC}@${release}`,
      DEEPSEEK_PROVIDER_PLUGIN_SPEC,
    ]
    : [DEEPSEEK_PROVIDER_PLUGIN_SPEC];
}

/**
 * Is a DeepSeek plugin payload the running core can load already on disk?
 *
 * The two registries install to different places, measured with the 2026.9.4
 * CLI against a scratch state directory: a ClawHub install writes
 * `<home>/extensions/deepseek/`, an npm one
 * `<home>/npm/projects/<package>-<hash>[__openclaw-generation__g-<gen>]/node_modules/@openclaw/deepseek-provider/`.
 * Looking only at the first made an npm-installed plugin read as missing, so
 * every configure — and every boot, in the script's twin of this — would
 * reinstall it.
 *
 * An npm payload counts only when it is the running core's own release: those
 * directories are keyed to the core generation, and one an older core left
 * behind is on disk yet unreachable (TASK-602). The ClawHub directory keeps
 * the rule it always had — present is present.
 *
 * Never throws; "could not tell" is `false`, which costs an install and
 * nothing worse.
 */
export async function deepseekPluginOnDisk(openclawHome: string): Promise<boolean> {
  try {
    await fs.access(path.join(openclawHome, "extensions", "deepseek", "openclaw.plugin.json"));
    return true;
  } catch {
    /* not from ClawHub — maybe from npm */
  }
  const candidates = [path.join(openclawHome, "npm", "node_modules", "@openclaw", "deepseek-provider")];
  try {
    const projects = await fs.readdir(path.join(openclawHome, "npm", "projects"));
    if (Array.isArray(projects)) {
      for (const project of projects) {
        if (typeof project !== "string") continue;
        candidates.push(path.join(openclawHome, "npm", "projects", project, "node_modules", "@openclaw", "deepseek-provider"));
      }
    }
  } catch {
    /* no npm projects at all */
  }
  let wanted: string | null | undefined;
  for (const dir of candidates) {
    let version: unknown;
    try {
      await fs.access(path.join(dir, "openclaw.plugin.json"));
      version = (JSON.parse(String(await fs.readFile(path.join(dir, "package.json"), "utf-8"))) as { version?: unknown })
        ?.version;
    } catch {
      continue;
    }
    // Asked once, and only when there is an npm payload to hold it against.
    if (wanted === undefined) wanted = await installedOpenclawRelease();
    if (!wanted || isBuildOf(version, wanted)) return true;
  }
  return false;
}

/** `2026.9.4`, or a republish of it (`2026.9.4-1`), for a `2026.9.4` core. */
function isBuildOf(version: unknown, release: string): boolean {
  if (typeof version !== "string" || !version.startsWith(release)) return false;
  const rest = version.slice(release.length);
  return rest === "" || rest.startsWith("-") || rest.startsWith("+");
}

export interface DeepseekPluginInstallResult {
  /** The spec that installed, or null when none did. */
  installed: string | null;
  /** One line per spec that failed, in the order they were tried. */
  failures: string[];
}

/**
 * Best effort: never throws — the caller's own write path names a missing plugin loudly.
 *
 * `force` is for a REPAIR (TASK-1088): after a core bump the old payload is
 * usually still on disk, and `plugins install` refuses to write over it
 * ("plugin already exists") without the flag. The configure route installs
 * only when the payload is absent, so it has no use for it — except on the npm
 * spec, which always carries it: the CLI reads `--force` there as the consent
 * to a non-ClawHub source as well, and this spec is only reached when no
 * payload for the running core is on disk, so whatever it replaces is stale.
 */
export async function installDeepseekProviderPlugin(
  options: { force?: boolean } = {},
): Promise<DeepseekPluginInstallResult> {
  const failures: string[] = [];
  let clawhubTimedOut = false;
  for (const spec of deepseekPluginSpecs(await installedOpenclawRelease())) {
    const fromNpm = spec.startsWith(`${DEEPSEEK_PROVIDER_NPM_SPEC}@`);
    // A ClawHub that let one spec run into its deadline will not answer the
    // next either: skipping it keeps the wait to the two attempts it was
    // before the npm step existed (the 2026-09-01 clawhub.dev outage burned the
    // full timeout on every one). The boot script skips the same way.
    if (!fromNpm && clawhubTimedOut) continue;
    try {
      await spawnOpenclawCli(
        ["plugins", "install", spec, ...(options.force || fromNpm ? ["--force"] : []), "--accept-capabilities"],
        { timeoutMs: INSTALL_TIMEOUT_MS },
      );
      return { installed: spec, failures };
    } catch (err) {
      // By name, not `instanceof`: suites that mock `./openclaw-config` leave
      // the class out, and a throw here would break "never throws".
      if (!fromNpm && err instanceof Error && err.name === "OpenclawSpawnTimeoutError") clawhubTimedOut = true;
      failures.push(`${spec}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { installed: null, failures };
}
