/**
 * Reading — and writing — WHO SPEAKS for this box, on whichever harness is
 * answering.
 *
 * SERVER ONLY.
 *
 * These four functions were `/setup-api/tts`'s own until the cloud defaults
 * needed them too: the resolver in `clawai-cloud-defaults.ts` has to be able to
 * ask the same question the Voice tab asks ("which engine does this box speak
 * with right now?") and to write the same answer the tab's own picker writes.
 * A second implementation of either would be a second set of harness branches,
 * and the dual SKU is exactly where those go wrong — a write chosen by "is the
 * openclaw binary here" lands in the config of the harness that is not talking.
 */

import { promises as fs } from "fs";
import { getActiveHarness } from "@/lib/harness";
import { CLAWBOX_AI_PROXY_URL, resolveClawaiToken } from "@/lib/harness/credentials";
import {
  hermesVoiceConfigView,
  readHermesVoice,
  selectHermesEngine,
  speechEntitledTier,
} from "@/lib/hermes-tts";
import { buildTtsInventory, KOKORO_STAMP, localTtsCommandRunnable, type LocalModelEntry } from "@/lib/local-models";
import { readConfig, runOpenclawConfigSet } from "@/lib/openclaw-config";
import {
  localCommandPath,
  type LocalVoiceProbe,
  type VoiceConfigView,
  type VoiceEngine,
} from "@/lib/voice-output";

export type ActiveHarness = Awaited<ReturnType<typeof getActiveHarness>>;

// `VoiceConfigView`, not `OpenClawConfig`: the only thing read here is the
// local provider's command, and both harnesses' configs are projected into
// that view. `OpenClawConfig` is structurally assignable to it.
export function localProbeFrom(
  config: VoiceConfigView,
  models: LocalModelEntry[],
  commandPresent: boolean,
): LocalVoiceProbe {
  const installedTts = models.filter((m) => m.kind === "tts" && m.installed);
  return {
    providerConfigured: Boolean(localCommandPath(config)),
    commandPresent,
    engineInstalled: installedTts.length > 0,
    engineNames: installedTts.map((m) => m.name),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The box's speech config, in the ONE shape the status builder reads —
 * whichever harness holds it.
 *
 * OpenClaw keeps it in openclaw.json; Hermes keeps it in its own `tts:` block
 * and `hermes-tts.ts` projects that into the same view. Everything downstream
 * (which engine is configured, what Auto resolves to, the privacy notice) is
 * then decided once, by rules neither edition can disagree about.
 *
 * The LOCAL engine is read the same way on both: `buildTtsInventory()` stats
 * Kokoro's own artefacts on this disk, and the provider entry's command has to
 * still be there. Hermes runs the same `clawbox-tts.sh` (install.sh registers
 * it as a `type: command` provider), so this half needed no edition of its own.
 */
export async function readVoiceConfig(harness: ActiveHarness): Promise<VoiceConfigView> {
  if (harness !== "hermes") return await readConfig();
  const [probe, token, entitled] = await Promise.all([
    readHermesVoice(),
    resolveClawaiToken(),
    speechEntitledTier(),
  ]);
  // The endpoint only for a box whose plan includes the cloud voice; see the
  // parameter's own note for why that is said as a null URL.
  return hermesVoiceConfigView(probe, token, entitled ? CLAWBOX_AI_PROXY_URL : null);
}

export async function probeBox(harness: ActiveHarness) {
  const [config, models] = await Promise.all([readVoiceConfig(harness), buildTtsInventory()]);
  const command = localCommandPath(config);
  // The provider entry names a script; if that script is gone — or is there but
  // cannot be run — the box cannot speak locally however healthy the voices
  // look. Through the shared helper, because the chat's spoken-reply capability
  // asks the same question and because the two editions spell `command`
  // differently: stat'ing Hermes' command LINE whole read every correctly
  // provisioned box on that edition as "not wired to use its voice".
  //
  // Fall back to the installer's own artefacts when no command is configured at
  // all — the stamp is a marker file, so its question is existence, not X_OK.
  const commandPresent = command
    ? await localTtsCommandRunnable(command)
    : await exists(KOKORO_STAMP);
  return { config, probe: localProbeFrom(config, models, commandPresent) };
}

/**
 * Which home this box's speech config lives in: top-level `tts` (OpenClaw 2)
 * or the legacy `messages.tts`. Decided by where a providers map actually
 * exists — the same rule voice-output.ts reads with — so a write can never
 * land in the other generation's slot beside the real one. A box with
 * NEITHER (fresh, unconfigured) gets the v2 home: the repo pairs with the
 * 2026.8 pin.
 */
export async function ttsConfigHome(): Promise<"tts" | "messages.tts"> {
  const config = await readConfig();
  const top = (config as { tts?: { providers?: unknown } }).tts;
  if (top && typeof top === "object" && top.providers) return "tts";
  const legacy = (config as { messages?: { tts?: { providers?: unknown } } }).messages?.tts;
  if (legacy && typeof legacy === "object" && legacy.providers) return "messages.tts";
  return "tts";
}

/**
 * Write the harness's selection: Hermes through its own writer, OpenClaw
 * through the CLI. Throws rather than answering a refusal, so a caller that
 * has a Response to build (the tts route) and one that only has a log to
 * write (the cloud defaults) each say it their own way.
 */
export async function writeActiveVoiceProvider(
  harness: ActiveHarness,
  engines: readonly VoiceEngine[],
  providerId: string,
): Promise<void> {
  if (harness === "hermes") {
    // Endpoint and credential first, selection last — see selectHermesEngine.
    const engine = engines.find((e) => e.providerId === providerId)?.id;
    if (!engine) throw new VoiceProviderUnavailableError();
    await selectHermesEngine(engine, await resolveClawaiToken());
    return;
  }
  await runOpenclawConfigSet([`${await ttsConfigHome()}.provider`, providerId]);
}

/** The box does not have the engine that provider id belongs to. */
export class VoiceProviderUnavailableError extends Error {
  readonly code = "not_available";
  constructor() {
    super("That voice is not available on this box.");
    this.name = "VoiceProviderUnavailableError";
  }
}
