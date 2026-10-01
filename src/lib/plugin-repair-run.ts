import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

import { awaitGatewayRestartAfter, readGatewayUnitMoment, type GatewayUnitMoment } from "@/lib/gateway-health";
import { installDeepseekProviderPlugin, installedOpenclawRelease } from "@/lib/openclaw-deepseek-plugin";
import { findOpenclawBin, runOpenclawConfigSet } from "@/lib/openclaw-config";
import { canonicalPluginId, type PluginRepairEntry, type PluginRepairStage } from "@/lib/plugin-repair";

const execFile = promisify(execFileCb);

// ONE repair, for the two things that run it (TASK-1088).
//
// The owner's Retry (`setup-api/plugins/repair`) and the updater's
// after-update retry (`plugin-repair-after-update.ts`) repair the same row the
// same way — the harness's own `plugins install` / `plugins enable`, the entry
// put back, the runtime asked whether the plugin actually loaded. They differ
// in what happens AROUND it: who waits, what restarts the gateway, and what a
// failure leaves on the row. Two copies of the middle had already drifted once
// (the updater's reinstall pins to the pin file, the Retry installed whatever
// the row said), and the box upgrading 2026.9.3 → 2026.9.4 is where that drift
// cost a repair: the row still named the OLD core's package.

// Asked per call, like the route did: `findOpenclawBin()` remembers only the
// managed core's path, and a fallback frozen at import outlives what it was
// true for.
const openclawBin = (): string => findOpenclawBin();

/** Long enough for an npm install on a Jetson, short enough to answer a click. */
const INSTALL_TIMEOUT_MS = 180_000;
const CONSENT_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 120_000;

/**
 * The npm packages ClawBox installs PINNED TO THE CORE, and therefore the only
 * specs that go stale when the core moves.
 *
 * `@openclaw/codex` is pinned by `scripts/gateway-pre-start.sh`'s codex block,
 * and the channel packages by `clawbox_managed_plugin_spec` — the same two
 * that are `OFFICIAL_CHANNEL_PLUGINS` in `openclaw-channels.ts`, which
 * `plugin-repair-run.test.ts` holds this list to. Not imported from there:
 * that module reads the config store at load, and the Retry route must not
 * need a config-store mock to be tested. DeepSeek is absent because its own
 * installer re-pins every time, and a `not-installed` row's spec is the core's
 * own unversioned `npmSpec`, which has nothing to rebase.
 */
export const CORE_PINNED_PLUGIN_PACKAGES: readonly string[] = [
  "@openclaw/codex",
  "@openclaw/discord",
  "@openclaw/whatsapp",
];

const PINNED_SPEC_RE = /^(@openclaw\/[a-z0-9][a-z0-9._-]*)@(\d{4}\.\d+\.\d+)((?:[-+][0-9A-Za-z.-]+)?)$/;

/**
 * The row's spec, moved onto the core that is on the box now.
 *
 * A row outlives the core it was written against — that is its job — and a
 * core update is exactly when it is read: the 2026.9.3 box's Codex row said
 * `@openclaw/codex@2026.9.3`, and a Retry that ran it on 2026.9.4 installed a
 * plugin built for a runtime the box no longer has. The version skew the pin
 * exists to prevent, in the other direction.
 *
 * Only a core-pinned ClawBox package, and only when it names a DIFFERENT base
 * release: `@openclaw/codex@2026.9.4-1` on a 2026.9.4 core is a republish of
 * the right one and is kept as written. Anything else, or an unknown release,
 * is returned unchanged.
 */
export function rebaseCorePinnedSpec(spec: string, release: string | null): string {
  const trimmed = spec.trim();
  if (!release) return trimmed;
  const match = PINNED_SPEC_RE.exec(trimmed);
  if (!match || !CORE_PINNED_PLUGIN_PACKAGES.includes(match[1])) return trimmed;
  if (match[2] === release) return trimmed;
  return `${match[1]}@${release}`;
}

/**
 * The installed core's release, or null — never a throw. A repair that cannot
 * learn the release still runs, on the spec the row carries.
 */
export async function currentCoreRelease(): Promise<string | null> {
  try {
    return await installedOpenclawRelease();
  } catch {
    return null;
  }
}

/**
 * The core's own words about a refusal, as ONE line to append to a reason.
 *
 * The TypeScript twin of `clawbox_plugin_cli_cause` in the boot script, with
 * the same shape — ` <verb> exited <code>: <line>` — so a row reads the same
 * whichever writer filed it. The line is the LAST one that reads like a
 * refusal (a CLI prints progress first and its verdict last), control
 * characters out, 160 characters at most, because Settings prints it verbatim
 * in an 11px row.
 */
export function cliFailureCause(verb: string, err: unknown): string {
  const e = (err && typeof err === "object" ? err : {}) as {
    code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown;
  };
  const text = [e.stdout, e.stderr].filter((s): s is string => typeof s === "string" && s.trim() !== "").join("\n")
    || (typeof e.message === "string" ? e.message : typeof err === "string" ? err : "");
  const head = e.killed === true || e.signal === "SIGTERM" || e.signal === "SIGKILL"
    ? `${verb} was killed at its deadline`
    : typeof e.code === "number"
      ? `${verb} exited ${e.code}`
      : typeof e.code === "string"
        ? `${verb} could not be run (${e.code})`
        : `${verb} failed`;
  return causeLine(head, text);
}

function causeLine(head: string, text: string): string {
  const lines = text
    // ANSI first, so a colour code cannot survive as stray letters.
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/).filter(Boolean).join(" "))
    .filter(Boolean);
  let picked = "";
  for (const line of lines) {
    if (/error|failed|cannot|not found|denied|refus|permission|schema/i.test(line)) picked = line;
  }
  if (!picked && lines.length > 0) picked = lines[lines.length - 1];
  if (!picked) return ` ${head} and said nothing.`;
  if (picked.length > 160) picked = `${picked.slice(0, 159).trimEnd()}…`;
  return ` ${head}: ${picked}`;
}

/** `Plugin not found` — the core's own words for a payload that is not on disk. */
function saysPluginNotFound(err: unknown): boolean {
  const e = (err && typeof err === "object" ? err : {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [e.stdout, e.stderr, e.message].some((s) => typeof s === "string" && /Plugin not found/i.test(s));
}

interface RuntimeInspection {
  plugin?: { id?: unknown; status?: unknown; activated?: unknown };
  diagnostics?: unknown;
}

/** What `plugins inspect --runtime` said, and — when it is not "loaded" — why, as one line. */
export interface RuntimeVerdict {
  /** See `harnessSaysLoaded`: null when the CLI could not be asked or read. */
  loaded: boolean | null;
  /** Empty only when `loaded` is true; otherwise one line led by a space, like `cliFailureCause`. */
  cause: string;
}

/**
 * The inspection's own account of a plugin that did not load: its status, its
 * activation, and the last diagnostic the core raised against it. What the row
 * says after a failed verify (TASK-1302): the board's row went on saying
 * "Version not found on ClawHub" over a plugin that had installed fine and was
 * merely switched off, because this step reported nothing at all.
 */
function inspectionCause(verb: string, parsed: RuntimeInspection, pluginId: string): string {
  const plugin = parsed.plugin ?? {};
  const head = `${verb} says status ${String(plugin.status ?? "unknown")}, activated ${String(plugin.activated ?? "unknown")}`;
  const messages = (Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [])
    .filter((d): d is { pluginId?: unknown; message: string } =>
      !!d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string")
    .filter((d) => d.pluginId === undefined || d.pluginId === pluginId)
    .map((d) => d.message);
  return messages.length > 0 ? causeLine(head, messages.join("\n")) : ` ${head}.`;
}

/**
 * Did this plugin actually LOAD, by the harness's own account?
 *
 * `plugins list` cannot answer that. It reads a persisted discovery snapshot —
 * `{"id":"discord","enabled":true,"status":"loaded","origin":"global"}` is the
 * shape `src/lib/openclaw-channels.ts` records for a globally installed package
 * whose `plugins.entries.<id>` is missing entirely — so "the CLI can see it" is
 * the one thing the boot script never doubted, and reading `enabled` as consent
 * would clear the badge for a plugin whose capability surface is still
 * unaccepted, putting the box straight back in the readiness-refusal loop.
 *
 * `plugins inspect <id> --runtime` module-loads it and reports what happened —
 * the same command `scripts/gateway-pre-start.sh` uses to prove its own hook
 * plugin registered. It is expensive (a registry snapshot plus a module load of
 * every enabled plugin, tens of seconds on an Orin), which is why the boot path
 * gates it behind a stamp and the repairs here do not: a person is waiting on a
 * button, or an update is, and the alternative is claiming a repair happened
 * because a command exited 0.
 *
 * Null when the CLI could not be asked or its answer could not be read — never
 * `false`, because "we could not check" and "it is still broken" want different
 * words on screen and only one of them should clear a badge.
 */
export async function harnessSaysLoaded(pluginId: string): Promise<boolean | null> {
  return (await inspectPluginRuntime(pluginId)).loaded;
}

/** `harnessSaysLoaded`, with the inspection's own words when the answer is not yes. */
export async function inspectPluginRuntime(pluginId: string): Promise<RuntimeVerdict> {
  const verb = "openclaw plugins inspect --runtime";
  const unreadable: RuntimeVerdict = { loaded: null, cause: ` ${verb} answered nothing this device could read.` };
  let stdout: string;
  try {
    ({ stdout } = await execFile(openclawBin(), ["plugins", "inspect", pluginId, "--runtime", "--json"], {
      timeout: INSPECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (err) {
    return { loaded: null, cause: cliFailureCause(verb, err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unreadable;
  }
  // `JSON.parse("null")` succeeds and the cast changes nothing at runtime, so
  // reading `.plugin` off it threw — where "the box could not be asked"
  // already has an answer the panel renders.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable;
  const plugin = (parsed as RuntimeInspection).plugin;
  if (!plugin || typeof plugin !== "object") return unreadable;
  if (plugin.status === undefined && plugin.activated === undefined) return unreadable;
  // BOTH, and neither inferred from the other: a plugin can be discovered
  // (`status: "loaded"`) and still refuse to activate on an unaccepted surface,
  // which is precisely the state that refuses gateway readiness.
  if (plugin.status === "loaded" && plugin.activated === true) return { loaded: true, cause: "" };
  return { loaded: false, cause: inspectionCause(verb, parsed as RuntimeInspection, pluginId) };
}

export type PluginRepairFailureCode = "no_spec" | "repair_failed" | "reenable_failed" | "unverified";

/** Which step a failed repair stopped at — what a re-filed row has to say. */
export type PluginRepairStep = "spec" | "enable" | "install" | "reenable" | "verify";

export type PluginRepairVerdict =
  | {
    ok: true;
    /** The stage that was actually repaired — `install` when a consent row's payload turned out gone. */
    stage: PluginRepairStage;
    /** The spec that ran (already rebased), or the row's own when nothing was installed. */
    spec: string;
  }
  | {
    ok: false;
    code: PluginRepairFailureCode;
    step: PluginRepairStep;
    stage: PluginRepairStage;
    spec: string;
    /**
     * One line in the core's words, led by a space — see `cliFailureCause`.
     * Empty only for `no_spec`, where nothing ran; a failed verify always
     * carries the inspection's own account (TASK-1302).
     */
    cause: string;
    /** This repair switched the entry on and then back off, so the switch-off is ClawBox's. */
    switchedOff: boolean;
  };

/** How the owner reads the plugin's name in a reason. */
export function pluginRepairLabel(id: string): string {
  switch (canonicalPluginId(id)) {
    case "codex": return "The ChatGPT (Codex) plugin";
    case "deepseek": return "The DeepSeek provider plugin, which ClawBox AI runs on,";
    default: return `The ${id} plugin`;
  }
}

/**
 * What went wrong, in the words the row keeps — see `PluginRepairStep`. Shared
 * by the Retry and the updater, so a row reads the same whichever re-filed it.
 */
export function pluginRepairFailureWhat(verdict: Extract<PluginRepairVerdict, { ok: false }>): string {
  // A consent row that stayed a consent row installed nothing.
  const redone = verdict.stage === "consent" ? "had its capabilities accepted" : "was reinstalled";
  switch (verdict.step) {
    case "spec": return "could not be reinstalled because its record names no package";
    case "enable": return "still could not have its capabilities accepted";
    case "install": return "could not be reinstalled";
    case "reenable": return `${redone} but could not be switched back on`;
    case "verify":
      return verdict.code === "unverified"
        ? `${redone} but the device could not confirm that it loads`
        : `${redone} but the core does not report it loaded`;
  }
}

export interface RunPluginRepairOptions {
  /** The installed core's release: a spec pinned to another core is moved onto this one. */
  release: string | null;
  /**
   * Also switch a ClawBox-disabled entry back off when the runtime COULD NOT BE
   * ASKED. The Retry leaves it on — a person is there, and taking a working
   * plugin down over a timed-out inspect would be a click that broke something —
   * while the updater, with nobody watching, keeps the boot script's rule:
   * never leave an unresolved plugin enabled.
   */
  switchOffWhenUnverified?: boolean;
  /**
   * After an install, wait out the restart it asks the RUNNING gateway for
   * before anything is switched on or asked (TASK-1302). The Retry sets it: the
   * gateway is up, and on the board it restarted itself on the install's
   * `plugins.installs` write in the middle of the repair, its pre-start writing
   * the same config and rows. The updater does not — it quiesces the gateway
   * around its installs, so there is no running gateway to restart.
   */
  awaitInstallRestart?: boolean;
}

/**
 * Repair one row, and PROVE it: `ok` only when the runtime says the plugin
 * loaded and activated. Never throws; never touches the row itself — what a
 * verdict does to the badge is the caller's, because only the caller knows
 * whether a gateway restart has confirmed it.
 *
 * What it writes to openclaw.json is `plugins.entries.<id>.enabled` and nothing
 * else — the provider's credentials, the model selection and the auth profiles
 * are not this function's to touch, and a repair that "fixed" a plugin by
 * rewriting them would be data loss with a green tick.
 */
export async function runPluginRepair(
  entry: PluginRepairEntry,
  options: RunPluginRepairOptions,
): Promise<PluginRepairVerdict> {
  // THE CANONICAL ID FOR THE REGISTRY, the configured key for the config.
  // `plugins enable` and `plugins inspect` look the id up in the registry
  // report, which keys plugins by their bare manifest id — so a marker filed
  // under `@openclaw/discord` would answer "plugin not found" on every press.
  // The `config set` writes keep the literal key, because those address the
  // config by the key it carries.
  const registryId = canonicalPluginId(entry.id);
  let spec = entry.spec ? rebaseCorePinnedSpec(entry.spec, options.release) : "";
  let stage: PluginRepairStage = entry.stage;
  let switchedOff = false;
  const fail = (code: PluginRepairFailureCode, step: PluginRepairStep, cause: string): PluginRepairVerdict =>
    ({ ok: false, code, step, stage, spec, cause, switchedOff });
  // Taken BEFORE the install, so a restart the install itself asks for is told
  // apart from the gateway that was already running.
  const gatewayBeforeInstall = async () => (options.awaitInstallRestart ? readGatewayUnitMoment() : null);
  const afterInstall = async (before: GatewayUnitMoment | null) => {
    if (options.awaitInstallRestart) await awaitGatewayRestartAfter(before);
  };

  // MATCHED ON `consent`, not on "anything that is not an install". The third
  // stage (`not-installed`, TASK-738) records an entry the core has no package
  // for at all, and `plugins enable` answers that with "Plugin not found".
  if (stage === "consent") {
    try {
      await execFile(openclawBin(), ["plugins", "enable", registryId, "--accept-capabilities"], {
        timeout: CONSENT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (err) {
      // A CONSENT ROW WHOSE PAYLOAD IS GONE is an install, and after a core
      // bump it is the common case: payloads live in npm projects keyed to the
      // core generation, so the new core cannot find what the old one
      // installed. The row carries the spec for exactly this (TASK-785), and
      // the boot re-attempt already re-files such a row upwards — but not for
      // Codex, which it does not visit, so the Retry ran the verb that had just
      // refused for ever. Upwards only, and only on the core's own wording.
      if (!(saysPluginNotFound(err) && (registryId === "deepseek" || spec))) {
        // `plugins enable` writes `enabled: true` BEFORE it loads anything and
        // can then fail, so an entry ClawBox had switched off may be ON now over
        // a plugin that does not load — the readiness refusal it was switched
        // off to avoid. Put it back where it was found.
        if (entry.disabled) {
          await switchOff(entry.id);
          switchedOff = true;
        }
        return fail("repair_failed", "enable", cliFailureCause("openclaw plugins enable", err));
      }
      if (entry.disabled) {
        await switchOff(entry.id);
        switchedOff = true;
      }
      stage = "install";
    }
  }

  if (stage !== "consent") {
    if (registryId === "deepseek") {
      // The DeepSeek provider has its own installer, and it is the one that
      // knows the registries and their order — pinned ClawHub, pinned npm, then
      // unpinned ClawHub, exactly as the boot script walks them — pinned to the
      // core that is on the box NOW, so it needs no rebase. `--force`, because
      // after a core bump the old payload is usually still on disk and the CLI
      // refuses to install over it otherwise.
      const before = await gatewayBeforeInstall();
      const result = await installDeepseekProviderPlugin({ force: true });
      if (!result.installed) {
        // The LAST attempt's refusal (TASK-1302). Each spec is tried because
        // the one before it failed, so the earlier refusals are already
        // answered: the 4.1 row kept saying "Version not found on ClawHub" for
        // a pinned build no Retry could ever fetch, over the fallback's own
        // refusal — the one that was actually still in the way.
        return fail("repair_failed", "install", causeLine(
          "openclaw plugins install failed",
          (result.failures[result.failures.length - 1] ?? "").replace(/^\S+:\s*/, ""),
        ));
      }
      spec = result.installed;
      await afterInstall(before);
    } else {
      // THE SPEC THE BOOT SCRIPT USED, never the short id: `codex` resolves
      // `@latest`, drifts ahead of the pinned runtime and crashes every Codex
      // chat. A marker written before the field existed has no spec, and this
      // refuses rather than guessing one — the next boot writes a full row.
      if (!spec) return fail("no_spec", "spec", "");
      const before = await gatewayBeforeInstall();
      try {
        // `--force` because the boot path uses it and because the CLI exits 1
        // with "plugin already exists (delete it first)" otherwise.
        await execFile(
          openclawBin(),
          ["plugins", "install", spec, "--force", "--accept-capabilities"],
          { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        );
      } catch (err) {
        return fail("repair_failed", "install", cliFailureCause("openclaw plugins install", err));
      }
      await afterInstall(before);
    }
  }

  // PUT BACK WHAT THE BOOT SCRIPT TOOK AWAY — BEFORE asking whether the repair
  // worked, because the answer depends on it. `openclaw plugins install`
  // deliberately leaves an entry that is explicitly `false` alone, so on the
  // install stage the payload comes back, the entry stays off, and
  // `plugins inspect --runtime` answers `status: "disabled"`. `plugins enable`
  // does flip it, so writing `true` over `true` is a no-op there.
  //
  // AND CLAWBOX AI'S OWN PLUGIN WHATEVER THE ROW'S `disabled` SAYS, once this
  // press has installed it (TASK-1302). The row a 4.1 boot filed says
  // `disabled: false` — there was no entry to switch off yet — and on the board
  // the entry was an explicit `false` all the same (`plugins uninstall
  // deepseek` leaves exactly that), so the Retry installed the plugin, left it
  // off, and answered `repair_failed` on every press. The press is the reason:
  // the owner asked for ClawBox AI's plugin back. The installer ran with
  // `--accept-capabilities`, so this write is all that is missing — measured on
  // 2026.9.4, the runtime then answers loaded and activated.
  //
  // `runOpenclawConfigSet` verifies the write against the file, so an
  // unwritable config is a failure rather than a green answer.
  const switchOn = entry.disabled || (registryId === "deepseek" && stage !== "consent");
  if (switchOn) {
    try {
      await runOpenclawConfigSet([`plugins.entries["${entry.id}"].enabled`, "true", "--strict-json"]);
    } catch (err) {
      return fail("reenable_failed", "reenable", cliFailureCause("openclaw config set", err));
    }
  }

  const runtime = await inspectPluginRuntime(registryId);
  if (runtime.loaded === true) return { ok: true, stage, spec };
  // The re-enable is a STEP of the repair, not its verdict — and only a plugin
  // that DEMONSTRABLY does not load is switched back off unless the caller
  // says otherwise (see `switchOffWhenUnverified`).
  if (switchOn && (runtime.loaded === false || options.switchOffWhenUnverified)) {
    await switchOff(entry.id);
    switchedOff = true;
  }
  return runtime.loaded === null
    ? fail("unverified", "verify", runtime.cause)
    : fail("repair_failed", "verify", runtime.cause);
}

/**
 * Best effort: a config that cannot be written is reported by the boot script's
 * own boot-without next time, and the row this came from still says off.
 */
async function switchOff(configuredId: string): Promise<void> {
  await runOpenclawConfigSet([`plugins.entries["${configuredId}"].enabled`, "false", "--strict-json"])
    .catch(() => undefined);
}
