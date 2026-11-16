/**
 * Which update CHANNEL this box follows (TASK-2602).
 *
 * Two channels, one codebase:
 *
 *   branch       every Jetson ClawBox and every other PC: the branch rules in
 *                `resolveUpdateBranch()` (src/lib/updater.ts) — the
 *                `.update-branch` pin, else the checkout's branch, else main —
 *                exactly as before this file existed.
 *   workstation  a ClawBox Workstation (DGX Spark and its partner builds):
 *                the `workstation` branch on origin, which is moved by hand
 *                (scripts/promote-workstation.sh) only after a version was
 *                tested on a Workstation. Never beta or main, and never a
 *                recorded pin: install-x64.sh records the branch it installed
 *                from, so a pin of `beta` on a Workstation is the installer's
 *                record, not a decision to follow beta.
 *
 * A Workstation is recognised the way the installer that set it up recognises
 * it (install-x64.sh `host_arch_or_refuse`): an arm64 host that is not a
 * Jetson (/etc/nv_tegra_release, the marker install.sh and install-x64.sh
 * share), whose checkout THIS install-x64.sh record names
 * (`hasX64Install`). An x86_64 PC installed with the same script is not a
 * Workstation and keeps the branch rules, as does a desktop with the x64
 * integration package, whose root side fetches the recorded branch itself.
 *
 * The override is `CLAWBOX_UPDATE_CHANNEL` (the web server reads the
 * checkout's `.env`, so it is a setting that survives updates):
 *
 *   workstation  follow the workstation branch on a PC installed with
 *                install-x64.sh that is not a Workstation (a test PC);
 *   branch       follow the branch rules on a Workstation, so Settings →
 *                System Update → Advanced options picks the branch (testing a
 *                beta build on a Workstation before promoting it);
 *   auto         (or unset) the hardware decides.
 *
 * Anything else is REFUSED rather than read as one of those: a typo must not
 * move a Workstation onto beta, and it must not leave a test PC on the
 * channel the tester meant to leave. The same goes for `workstation` on a box
 * whose checkout install.sh moves (a Jetson) or the desktop integration's root
 * step fetches: the TS updater does not own those fetches, so honouring it
 * there would split one update between two branches.
 *
 * SERVER ONLY.
 */

import fs from "fs";
import os from "os";
import { TEGRA_RELEASE } from "./ollama-size-cap";
import { hasX64DesktopIntegration, hasX64Install } from "./x64-integration";

/** The branch on origin a ClawBox Workstation updates from. */
export const WORKSTATION_UPDATE_REF = "workstation";

/** The override's environment variable (see the file comment). */
export const UPDATE_CHANNEL_ENV = "CLAWBOX_UPDATE_CHANNEL";

/** What the channel decision needs to know about the machine. */
export interface UpdateHost {
  /** /etc/nv_tegra_release is present: a Jetson, which install.sh owns. */
  jetson: boolean;
  /** `os.arch()`: "arm64", "x64", … */
  arch: string;
  /** install-x64.sh installed THIS checkout (`hasX64Install`). */
  x64Install: boolean;
  /** The x64 desktop integration package owns this checkout (`hasX64DesktopIntegration`). */
  desktopIntegration: boolean;
}

export type UpdateChannel =
  | {
      kind: "workstation";
      /** The branch on origin this channel follows. */
      ref: string;
      /** `hardware`: this is a Workstation; `override`: CLAWBOX_UPDATE_CHANNEL said so. */
      source: "hardware" | "override";
    }
  | { kind: "branch"; source: "hardware" | "override" };

/**
 * The channel could not be decided without guessing. Thrown, so the update
 * refuses with this sentence and the check reports it, instead of either one
 * falling through to the branch rules — which on a Workstation means beta or
 * main.
 */
export class UpdateChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateChannelError";
  }
}

/** A ClawBox Workstation: arm64, not a Jetson, installed with install-x64.sh. */
export function isWorkstationHost(host: UpdateHost): boolean {
  return host.arch === "arm64" && !host.jetson && host.x64Install && !host.desktopIntegration;
}

/** Pure: the channel for `host` under `env`. Throws UpdateChannelError. */
export function resolveUpdateChannel(
  host: UpdateHost,
  env: Record<string, string | undefined> = process.env,
): UpdateChannel {
  const raw = env[UPDATE_CHANNEL_ENV];
  const override = (raw ?? "").trim().toLowerCase();

  if (override === "branch") return { kind: "branch", source: "override" };
  if (override === "workstation") {
    if (host.jetson || !host.x64Install || host.desktopIntegration) {
      throw new UpdateChannelError(
        `${UPDATE_CHANNEL_ENV}=workstation only applies to a computer installed with install-x64.sh, `
        + "where the updater fetches and moves the checkout itself. On this box "
        + (host.desktopIntegration ? "the desktop integration's root step" : "install.sh")
        + " updates from the recorded branch, so the setting cannot be honoured. Refusing to update "
        + `until it is removed from the checkout's .env (or set to "branch").`,
      );
    }
    return { kind: "workstation", ref: WORKSTATION_UPDATE_REF, source: "override" };
  }
  if (override !== "" && override !== "auto") {
    throw new UpdateChannelError(
      `${UPDATE_CHANNEL_ENV} is set to "${(raw ?? "").trim().slice(0, 40)}", which is not an update channel. `
      + 'Use "workstation", "branch" or "auto" (or remove it from the checkout\'s .env). '
      + "Refusing to guess which branch to update from.",
    );
  }

  if (isWorkstationHost(host)) {
    return { kind: "workstation", ref: WORKSTATION_UPDATE_REF, source: "hardware" };
  }
  return { kind: "branch", source: "hardware" };
}

export interface ProbeOptions {
  tegraRelease?: string;
  arch?: string;
  hasX64Install?: (projectDir: string) => boolean;
  hasX64DesktopIntegration?: (projectDir: string) => boolean;
}

/**
 * Read the machine. A Jetson answers from the Tegra marker alone: its
 * x64 records are never opened, so nothing about a Jetson's update can start
 * failing here. On any other host an x64 record that is there and cannot be
 * trusted (`readRootOwnedProjectDir` refuses it) is an UpdateChannelError:
 * whether this is a Workstation is exactly what that record would have said,
 * and guessing "no" would put a Workstation on beta.
 */
export function probeUpdateHost(projectDir: string, options: ProbeOptions = {}): UpdateHost {
  const jetson = fs.existsSync(/* turbopackIgnore: true */ options.tegraRelease ?? TEGRA_RELEASE);
  const arch = options.arch ?? os.arch();
  if (jetson) return { jetson, arch, x64Install: false, desktopIntegration: false };
  try {
    const desktopIntegration = (options.hasX64DesktopIntegration ?? hasX64DesktopIntegration)(projectDir);
    const x64Install = !desktopIntegration && (options.hasX64Install ?? hasX64Install)(projectDir);
    return { jetson, arch, x64Install, desktopIntegration };
  } catch (err) {
    throw new UpdateChannelError(
      "Could not tell whether this computer is a ClawBox Workstation, so its update channel is unknown: "
      + (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * The check's sentence when origin has no workstation branch: nothing has
 * been released to Workstations yet (or the branch was deleted). The box
 * stays where it is — it is never compared against beta or main instead.
 */
export function workstationRefMissingReason(ref: string = WORKSTATION_UPDATE_REF): string {
  return `No version has been released on the ClawBox Workstation update channel yet: GitHub has no "${ref}" `
    + "branch. This Workstation stays on the version it has and does not follow beta or main instead.";
}

/** The update's sentence for the same case, said before anything was changed. */
export function workstationRefMissingUpdateError(ref: string = WORKSTATION_UPDATE_REF): string {
  return `There is nothing to update to: no version has been released on the ClawBox Workstation update channel `
    + `yet (GitHub has no "${ref}" branch). Nothing was changed — this Workstation stays on the version it has, `
    + "and it never falls back to beta or main.";
}
