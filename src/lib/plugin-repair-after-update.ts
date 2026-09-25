import { runOpenclawConfigSet } from "@/lib/openclaw-config";
import {
  canonicalPluginId,
  claimPluginRepair,
  clearPluginRepairUnlessRefiled,
  pluginRepairInProgress,
  readPluginRepairs,
  recordPluginRepair,
  setPluginRepairInProgress,
  type PluginRepairEntry,
  type PluginRepairs,
} from "@/lib/plugin-repair";
import { runPluginRepair, type PluginRepairVerdict } from "@/lib/plugin-repair-run";
import { readPluginInstallUnavailable } from "@/lib/plugin-install-unavailable";

/**
 * The DeepSeek provider plugin's canonical id. Spelled here rather than taken
 * from `openclaw-deepseek-plugin`, which the suites of this module replace with
 * a two-function mock.
 */
const DEEPSEEK_PLUGIN_ID = "deepseek";

// The repair a CORE UPDATE owes the rows it stranded (TASK-1088).
//
// A box that failed its V4.0 update against OpenClaw 2026.9.3 — the core
// refused the schema-17 store a 2026.9.4 core had already migrated — also
// failed to install or consent Codex and the DeepSeek provider at boot, so the
// boot script switched both off and filed both as "Needs repair". The update
// that finally lands 2026.9.4 fixes the cause, and nothing looked at the rows
// again:
//
//   * the updater repairs what the gateway's JOURNAL refuses, and a plugin
//     that is switched off is never refused — the gateway comes up without it;
//   * the boot script's re-attempt runs `plugins enable` only, never the
//     reinstall a core bump needs, and never visits Codex at all;
//   * and a Retry installed the spec the row named — the OLD core's package.
//
// So the owner was left pressing Retry on two providers after an update that
// had removed the reason they were broken. This is the retry the update owes:
//
//   ONLY WHAT CLAWBOX SWITCHED OFF (`disabled: true`) — the same line the boot
//   re-attempt and `pluginConsentRepairIsAllowed` draw, because an entry the
//   owner turned off is his;
//   ONLY THE TWO PROVIDER PLUGINS ClawBox installs itself — Codex and the
//   DeepSeek provider ClawBox AI runs on. The channels keep their own boot
//   re-attempt and the Retry; `not-installed` rows wait for the owner's press,
//   because installing a package nobody on the box chose is his call;
//   ONCE PER CORE, recorded on the row as `retriedCore` in the same write that
//   starts the attempt, so a resumed or repeated update does nothing twice and
//   the next core bump tries again. Never at boot: an install is minutes of npm
//   and the boot is a blocking ExecStartPre;
//   AND PROVED END TO END — the runtime asked, the gateway restarted and READY
//   with the plugin switched on, and the row still the one this set out to
//   repair — before the badge goes. Anything less puts the plugin back off and
//   re-files the row with the cause, in the core's own words.
//
// Credentials and the provider selection are not touched: the only write to
// openclaw.json on this path is `plugins.entries.<id>.enabled`.

/** The plugins the update retries on its own initiative, by canonical id. */
export const AFTER_UPDATE_RETRY_PLUGINS: readonly string[] = ["codex", "deepseek"];

/** Eligible in every respect except the core it was last retried on. */
function retryable(row: PluginRepairEntry, nowMs: number): boolean {
  return AFTER_UPDATE_RETRY_PLUGINS.includes(canonicalPluginId(row.id))
    && row.disabled
    && (row.stage === "install" || row.stage === "consent")
    && !pluginRepairInProgress(row, nowMs);
}

/** The rows this core update owes a retry, oldest first. */
export function pluginRepairsDueAfterCoreUpdate(
  repairs: PluginRepairs,
  release: string,
  nowMs: number = Date.now(),
): PluginRepairEntry[] {
  return Object.values(repairs)
    .filter((row) => retryable(row, nowMs) && row.retriedCore !== release)
    .sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

export interface AfterCoreUpdateRetryHooks {
  /** The installed core's release. Null skips the retry: it cannot be bounded per core without one. */
  release: () => Promise<string | null>;
  /**
   * Run with the gateway stopped and masked — the updater's `withGatewayQuiesced`.
   * It lifts the mask afterwards but does NOT start the gateway again, so every
   * quiesce here is followed by `restartAndVerify`.
   */
  quiesce: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Restart the gateway and resolve only once it is READY; throw when it is not. */
  restartAndVerify: () => Promise<void>;
  log?: (line: string) => void;
}

export interface AfterCoreUpdateRetryResult {
  release: string | null;
  /** Canonical ids repaired and confirmed by a gateway that came back ready. */
  repaired: string[];
  /** Canonical ids retried and re-filed with the cause. */
  failed: string[];
}

/** How the owner reads the plugin's name in a reason. */
function pluginLabel(id: string): string {
  switch (canonicalPluginId(id)) {
    case "codex": return "The ChatGPT (Codex) plugin";
    case "deepseek": return "The DeepSeek provider plugin, which ClawBox AI runs on,";
    default: return `The ${id} plugin`;
  }
}

/** What went wrong, in the words the row keeps — see `PluginRepairStep`. */
function whatFailed(verdict: Extract<PluginRepairVerdict, { ok: false }>): string {
  switch (verdict.step) {
    case "spec": return "could not be reinstalled because its record names no package";
    case "enable": return "still could not have its capabilities accepted";
    case "install": return "could not be reinstalled";
    case "reenable": return "was reinstalled but could not be switched back on";
    case "verify":
      return verdict.code === "unverified"
        ? "was reinstalled but the device could not confirm that it loads"
        : "was reinstalled but the core does not report it loaded";
  }
}

/**
 * Retry every row this core owes a retry, and leave each one either GONE — the
 * plugin loads under a gateway that came back ready — or re-filed with why not.
 *
 * Throws only what `hooks` throw, and only once the plugins it switched on are
 * switched off again: a gateway that will not come back even then is the
 * update's failure, reported the way every other one is.
 */
export async function retryPluginRepairsAfterCoreUpdate(
  hooks: AfterCoreUpdateRetryHooks,
): Promise<AfterCoreUpdateRetryResult> {
  const log = hooks.log ?? ((line: string) => console.log(`[Updater] ${line}`));
  const nothing: AfterCoreUpdateRetryResult = { release: null, repaired: [], failed: [] };

  // The healthy box pays one file read and nothing else: no rows, no CLI call.
  let repairs: PluginRepairs;
  try {
    repairs = await readPluginRepairs();
  } catch {
    return nothing;
  }
  const nowMs = Date.now();
  if (!Object.values(repairs).some((row) => retryable(row, nowMs))) return nothing;

  const release = await hooks.release().catch(() => null);
  if (!release) {
    log("could not read the installed OpenClaw release; plugins switched off for repair are left to the Retry in Settings");
    return nothing;
  }
  const eligible: PluginRepairEntry[] = [];
  for (const row of pluginRepairsDueAfterCoreUpdate(repairs, release, nowMs)) {
    // A BUILD THE REGISTRY DOES NOT HAVE FOR THIS CORE is not retried (TASK-1206).
    // The restart this update has just done ran the gateway pre-start, which
    // asked for it and recorded the answer; retrying here would ask again, and
    // a retry is not an install alone — it stops the gateway, installs, starts
    // it and waits for ready, a minute and more on the update's final step for
    // an answer that is already known. Not claimed either: `retriedCore` is for
    // a retry that ran, and this one did not.
    if (canonicalPluginId(row.id) === DEEPSEEK_PLUGIN_ID) {
      const known = await readPluginInstallUnavailable(DEEPSEEK_PLUGIN_ID, release, nowMs).catch(() => null);
      if (known) {
        log(
          `not retrying the ${row.id} plugin: OpenClaw ${release} has no installable build of it on record `
            + `(${known.cause || "no installable build"}); ClawBox AI runs on its provider transport meanwhile`,
        );
        continue;
      }
    }
    eligible.push(row);
  }
  if (eligible.length === 0) return { ...nothing, release };

  // SPENT BEFORE IT RUNS, and said on the row so the panel reads "Repairing…"
  // rather than offering a Retry that would race this one — CLAIMED, not just
  // stamped: the check that no Retry got there first and the stamp are one
  // locked write, and a row an owner's Retry holds is left to that Retry. A
  // store that cannot be written is no reason to skip the retry this core owes.
  const due: PluginRepairEntry[] = [];
  for (const row of eligible) {
    const claim = await claimPluginRepair(row.id, { retriedCore: release }).catch(() => null);
    if (claim === "busy") log(`the ${row.id} plugin is already being repaired; leaving it to that repair`);
    if (claim === "busy" || claim === "absent") continue;
    due.push(row);
  }
  if (due.length === 0) return { ...nothing, release };

  // EVERY CLAIMED ROW LEAVES THIS FUNCTION UNSTAMPED, however it leaves
  // (TASK-1198). The branches below end each row as they settle it, but a throw
  // between two of them — a quiesce hook that failed after some installs had
  // run, an installer that rejected mid-loop — used to carry the stamps of the
  // rows already attempted out with it, and the owner's Retry answered 409 over
  // them for the next 20 minutes. A row the store has already moved on —
  // re-filed, which never carries the stamp, or cleared — is left alone: by
  // then it may be an owner's Retry's to end.
  const settled = new Set<PluginRepairEntry>();
  try {
    return await retryClaimedRows(due, release, log, hooks, settled);
  } finally {
    for (const row of due) {
      if (!settled.has(row)) await setPluginRepairInProgress(row.id, false).catch(() => false);
    }
  }
}

/**
 * The retry itself, for rows already claimed. Adds each row to `settled` once
 * its stamp is gone — re-filed, cleared or explicitly ended — and may throw;
 * the caller ends whatever is left.
 */
async function retryClaimedRows(
  due: PluginRepairEntry[],
  release: string,
  log: (line: string) => void,
  hooks: AfterCoreUpdateRetryHooks,
  settled: Set<PluginRepairEntry>,
): Promise<AfterCoreUpdateRetryResult> {
  log(`retrying the ${due.map((row) => row.id).join(", ")} plugin repair after the OpenClaw ${release} update`);

  const endStamp = async (row: PluginRepairEntry) => {
    await setPluginRepairInProgress(row.id, false).catch(() => false);
    settled.add(row);
  };

  const refile = async (row: PluginRepairEntry, stage: PluginRepairEntry["stage"], spec: string, reason: string) => {
    try {
      await recordPluginRepair({ id: row.id, stage, reason, disabled: true, spec, retriedCore: release });
      settled.add(row);
    } catch (err) {
      // The row is still there — only its reason is old — and the stamp above
      // already bounds the retry. Said where an update is looked into.
      log(`could not record why the ${row.id} repair failed: ${err instanceof Error ? err.message : String(err)}`);
      await endStamp(row);
    }
  };

  const attempts: { row: PluginRepairEntry; verdict: PluginRepairVerdict }[] = [];
  try {
    // One writer for the store: the gateway is stopped for the installs and the
    // runtime inspections, exactly as for every other repair this update makes.
    await hooks.quiesce(async () => {
      for (const row of due) {
        // A Codex row filed before rows carried a spec is still ClawBox's own
        // pinned package; the Retry has to refuse to guess, this does not.
        const withSpec = !row.spec && canonicalPluginId(row.id) === "codex"
          ? { ...row, spec: `@openclaw/codex@${release}` }
          : row;
        attempts.push({ row, verdict: await runPluginRepair(withSpec, { release, switchOffWhenUnverified: true }) });
      }
    });
  } finally {
    // Whatever did not get an attempt — a quiesce that failed before running —
    // is no longer being repaired, and must not read as though it were.
    for (const row of due) {
      if (!attempts.some((attempt) => attempt.row === row)) await endStamp(row);
    }
  }

  const failed: string[] = [];
  const repairedOnDisk: { row: PluginRepairEntry; stage: PluginRepairEntry["stage"]; spec: string }[] = [];
  for (const { row, verdict } of attempts) {
    if (verdict.ok) {
      repairedOnDisk.push({ row, stage: verdict.stage, spec: verdict.spec });
      continue;
    }
    failed.push(canonicalPluginId(row.id));
    log(`the ${row.id} repair failed at ${verdict.step}:${verdict.cause || " no further detail"}`);
    await refile(
      row,
      verdict.stage,
      verdict.spec,
      `${pluginLabel(row.id)} was retried after the OpenClaw ${release} update and ${whatFailed(verdict)}, `
        + `so it stays switched off.${verdict.cause}`,
    );
  }
  if (repairedOnDisk.length === 0) {
    // Nothing to load — but the quiesce STOPPED the gateway, and lifting the
    // mask does not start it. Bring it back exactly as the update found it: up,
    // without the plugins that are still switched off.
    await hooks.restartAndVerify();
    return { release, repaired: [], failed };
  }

  // THE RESTART IS WHAT LOADS THEM, and the only proof worth a cleared badge is
  // a gateway that came back READY with them switched on. A command that ran is
  // not that proof, and neither is a runtime inspection with the gateway down.
  try {
    await hooks.restartAndVerify();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`the gateway did not come back with the repaired plugins switched on (${detail}); switching them off again`);
    // PUT THE BOX BACK exactly as the update found it: the plugins off, the rows
    // saying why, and a gateway that comes up without them.
    const switchOffAll = async () => {
      for (const { row } of repairedOnDisk) {
        await runOpenclawConfigSet([`plugins.entries["${row.id}"].enabled`, "false", "--strict-json"])
          .catch(() => undefined);
      }
    };
    try {
      try {
        await hooks.quiesce(switchOffAll);
      } catch (quiesceErr) {
        // A gateway restart-looping over the plugin it just loaded is exactly
        // the one the quiesce can fail to wait out. The entries still come off
        // — `config set` needs no gateway — and the rows below still say why;
        // leaving either behind would hand `ensureGatewayHealthy` a box that
        // reads "Repairing…" over a config it is about to recover.
        const why = quiesceErr instanceof Error ? quiesceErr.message : String(quiesceErr);
        log(`could not quiesce the gateway to switch the repaired plugins off (${why}); switching them off anyway`);
        await switchOffAll();
      }
    } finally {
      // EVERY ROW IS RE-FILED whatever the switch-off did: a row left behind here
      // says "Repairing…" over a plugin nothing is repairing.
      for (const { row, stage, spec } of repairedOnDisk) {
        failed.push(canonicalPluginId(row.id));
        await refile(
          row,
          stage,
          spec,
          `${pluginLabel(row.id)} was repaired after the OpenClaw ${release} update, but the gateway did not `
            + "report ready with it switched on, so it was switched off again.",
        );
      }
    }
    await hooks.restartAndVerify();
    return { release, repaired: [], failed };
  }

  const repaired: string[] = [];
  for (const { row } of repairedOnDisk) {
    let outcome: "cleared" | "absent" | "refiled" | null;
    try {
      outcome = await clearPluginRepairUnlessRefiled(row.id, row.atMs);
    } catch {
      outcome = null;
    }
    if (outcome !== null) settled.add(row);
    if (outcome === "refiled") {
      // The restart's own pre-start asked the core about it, got no, switched
      // it off again and filed the cause. That row is the truth now — and it
      // keeps `retriedCore`, so this core does not retry it again.
      failed.push(canonicalPluginId(row.id));
      log(`the gateway pre-start switched ${row.id} off again after the repair; its repair record says why`);
      continue;
    }
    if (outcome === null) {
      // Repaired and running; only the bookkeeping failed. The boot script's
      // consent loop clears the row at the next start, and until then it must
      // at least stop saying "Repairing…".
      log(`the ${row.id} plugin was repaired but its repair record could not be cleared`);
      await endStamp(row);
    }
    repaired.push(canonicalPluginId(row.id));
  }
  if (repaired.length > 0) log(`repaired after the OpenClaw ${release} update: ${repaired.join(", ")}`);
  return { release, repaired, failed };
}
