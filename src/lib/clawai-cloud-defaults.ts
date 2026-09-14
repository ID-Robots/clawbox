/**
 * Applying the owner's decision of 2026-09-14: speech out, speech in and memory
 * embeddings default to the ClawBox AI cloud on a box that has a subscription
 * covering them, and to the engine on the box otherwise.
 *
 * SERVER ONLY. The rule itself is pure and lives in
 * `@/lib/clawai-cloud-defaults-state`, so the Local AI panel can explain the
 * same verdict this file acts on.
 *
 * TWO PROPERTIES HOLD THIS TOGETHER, and both are about not taking something
 * away from the person who owns the box:
 *
 *  1. IT ONLY EVER PROMOTES. Nothing here moves a capability from the cloud to
 *     the box. A plan that no longer covers the cloud voice is withdrawn by the
 *     boot script that armed it (`gateway-pre-start.sh`, the one irreversible
 *     act in that file and gated on the PLAN alone); an unusable cloud leg is
 *     already handled at request time by each chain's own fall-through. An
 *     applier that also demoted would be a second, unsynchronised opinion about
 *     the same withdrawal, and the two would disagree on the box where it
 *     matters — a Max subscriber whose device badge says Flash.
 *
 *  2. AN EXPLICIT OWNER CHOICE IS NEVER OVERWRITTEN. Every surface that lets a
 *     person pick records `owner` in this capability's source key, and a box
 *     that predates the key is read through `ownerChoiceFrom`: a stored `local`
 *     could only have come from a person, because nothing else ever wrote one.
 *
 * So the worst this can do on a box that was working is point it at a cloud
 * engine its subscription covers, which is what was asked for; and the most it
 * can do on a box that was not is nothing.
 */


import { readClawaiEntitlementTier } from "@/lib/clawai-plan-tier";
import { readChoiceSource } from "@/lib/clawai-cloud-choice";
import { get } from "@/lib/config-store";
import {
  ownerChoiceFrom,
  resolveClawaiCloudDefaults,
  type CapabilitySource,
  type CloudCapability,
  type CloudDefaultsFacts,
  type CloudUnavailableReason,
} from "@/lib/clawai-cloud-defaults-state";
import {
  cloudEmbeddingsUrl,
  forgetCloudEmbeddingsProbe,
  probeCloudEmbeddings,
} from "@/lib/clawai-cloud-embeddings";
import { invalidateMemoryStatusCache, startMemoryIndex } from "@/lib/clawkeep-memory";
import { getActiveHarness } from "@/lib/harness";
import { resolveClawaiToken } from "@/lib/harness/credentials";
import { isLoopbackBaseUrl } from "@/lib/embed-runtime-ids";
import { getMemoryShardEnabled, readEmbeddingChoice, switchToCloudEmbeddings } from "@/lib/memory-shard";
import { openclawIsAbsent } from "@/lib/openclaw-config";
import { createSerialLock } from "@/lib/serial-lock";
import { syncChannelAudio } from "@/lib/stt-channel";
import { localSttInstalled } from "@/lib/stt-local";
import { getSttPrimary, setSttPrimary, sttEngineOrder, STT_PRIMARY_KEY } from "@/lib/stt-preference";
import { probeBox, writeActiveVoiceProvider } from "@/lib/voice-box";
import { buildVoiceOutputStatus } from "@/lib/voice-output";
import { readVoiceState } from "@/lib/voice-output-store";
import type { ClawboxAiPlanTier } from "@/lib/clawbox-ai-models";

/** What one capability looks like right now, and what the default says it should. */
export interface CapabilityState {
  /** Where the box serves it from today. */
  source: CapabilitySource;
  /** Where the default says it should come from. */
  target: CapabilitySource;
  /** The owner said so in as many words (or in a way only a person could). */
  ownerChoice: boolean;
  /** Why it is not on the cloud, or null when it is. */
  reason: CloudUnavailableReason | null;
}

export interface CloudDefaultsStatus {
  /** A ClawBox AI credential is on this box. */
  linked: boolean;
  /** The entitlement on record — the plan, or the device badge behind it. */
  plan: ClawboxAiPlanTier | null;
  capabilities: Record<CloudCapability, CapabilityState>;
}

/** What one run of the applier did. */
export interface CloudDefaultsApplied {
  /** Capabilities this run moved onto the cloud. */
  moved: CloudCapability[];
  /** Capabilities it wanted to move and could not, with the reason in English. */
  failed: { capability: CloudCapability; error: string }[];
}

/**
 * Ask the proxy's embeddings route only when the answer could change anything.
 *
 * A box with no credential, an unpaid plan, or an edition that indexes on the
 * device cannot use the cloud embedder whatever the route says, and a request
 * per boot on every such box is a request per boot for nothing.
 */
async function embeddingsRouteReady(linked: boolean, plan: ClawboxAiPlanTier | null, supported: boolean) {
  if (!linked || !supported) return false;
  if (plan !== "flash" && plan !== "pro") return false;
  return await probeCloudEmbeddings();
}

/** The four facts the rule is a function of. */
export async function readCloudDefaultsFacts(): Promise<CloudDefaultsFacts> {
  const [token, entitlement] = await Promise.all([resolveClawaiToken(), readClawaiEntitlementTier()]);
  const linked = token !== null;
  // ClawBox is the indexer on the edition with no OpenClaw, and its embedder
  // client refuses any endpoint that is not loopback — deliberately, because
  // the owner's document text is the request body there. See the fact's own
  // docblock; a default may not open that fence.
  const embeddingsSupported = !openclawIsAbsent();
  return {
    linked,
    entitlement,
    embeddingsSupported,
    embeddingsRouteReady: await embeddingsRouteReady(linked, entitlement, embeddingsSupported),
  };
}

/** Which engine speaks for this box right now. */
async function currentVoiceSource(): Promise<CapabilitySource> {
  const harness = await getActiveHarness();
  const [{ config, probe }, state] = await Promise.all([probeBox(harness), readVoiceState()]);
  const status = buildVoiceOutputStatus(config, probe, state);
  // The provider actually written, and only when that is neither engine does
  // the resolved preference stand in: a box mid-provisioning has a choice but
  // nothing selected yet, and reporting that as "local" would make the applier
  // think it had work to do.
  return (status.activeEngine ?? status.preferredEngine ?? "local") === "cloud" ? "cloud" : "local";
}

/** Where the memory index is embedded right now. */
async function currentEmbeddingSource(): Promise<CapabilitySource> {
  if (openclawIsAbsent()) return "local";
  const { baseUrl } = await readEmbeddingChoice();
  // No endpoint at all is the on-device answer: the only thing this box points
  // at without one is its own embedder, and claiming "cloud" over an unset key
  // would make the applier skip the write that puts it right.
  if (!baseUrl) return "local";
  return isLoopbackBaseUrl(baseUrl) ? "local" : "cloud";
}

/**
 * Every capability's current engine, what the rule says it should be, and who
 * decided. Read-only — nothing here writes.
 */
export async function readCloudDefaultsStatus(): Promise<CloudDefaultsStatus> {
  const facts = await readCloudDefaultsFacts();
  const defaults = resolveClawaiCloudDefaults(facts);
  const [stt, tts, embeddings, owners] = await Promise.all([
    getSttPrimary(),
    currentVoiceSource(),
    currentEmbeddingSource(),
    readOwnerChoices(),
  ]);
  const current: Record<CloudCapability, CapabilitySource> = { stt, tts, embeddings };
  const capabilities = {} as Record<CloudCapability, CapabilityState>;
  for (const capability of ["tts", "stt", "embeddings"] as const) {
    const owner = owners[capability];
    const verdict = defaults[capability];
    capabilities[capability] = {
      source: current[capability],
      // An owner pick is the target: the default does not get to move it, so
      // saying otherwise would put a permanent "should be cloud" on a box that
      // is doing what it was told.
      target: owner ? current[capability] : verdict.source,
      ownerChoice: owner,
      reason: owner && current[capability] === "local" ? "owner" : verdict.reason,
    };
  }
  return { linked: facts.linked, plan: facts.entitlement, capabilities };
}

/**
 * Who chose each capability's engine.
 *
 * The recorded source, and — for a box that predates the key — the one stored
 * value only a person could have produced. See `ownerChoiceFrom`.
 */
async function readOwnerChoices(): Promise<Record<CloudCapability, boolean>> {
  const [ttsSource, sttSource, embedSource, storedStt, voiceState] = await Promise.all([
    readChoiceSource("tts"),
    readChoiceSource("stt"),
    readChoiceSource("embeddings"),
    get(STT_PRIMARY_KEY),
    readVoiceState(),
  ]);
  return {
    tts: ownerChoiceFrom(ttsSource, voiceState.choice === "local"),
    stt: ownerChoiceFrom(sttSource, storedStt === "local"),
    // Nothing before this feature recorded an embedding pick — the boot script
    // wrote the on-device embedder on every box — so there is no earlier
    // "only a person could have done this" value to grandfather here.
    embeddings: ownerChoiceFrom(embedSource, false),
  };
}

/**
 * One applier at a time in this process.
 *
 * Boot and a credential save can land together — the web server starts while a
 * wizard is finishing — and each step below is read-then-write across seconds of
 * CLI spawn. Idempotence already means a second run writes nothing; the lock is
 * what stops two runs from both deciding to write the same thing first.
 */
const withApply = createSerialLock();

export interface ApplyOptions {
  /** For the log line, so a boot apply and a link apply are tellable apart. */
  trigger?: "boot" | "link" | "owner";
  /** The credential changed: anything learned about the last one is stale. */
  credentialChanged?: boolean;
}

/**
 * Put this box on the cloud engines its subscription covers.
 *
 * Never throws and never rejects: it runs from `instrumentation.ts` at boot and
 * from the tail of a credential save, and neither of those may fail because a
 * default could not be applied. Each capability is attempted on its own, so one
 * refusal does not cost the other two.
 */
export async function applyClawaiCloudDefaults(options: ApplyOptions = {}): Promise<CloudDefaultsApplied> {
  if (options.credentialChanged) forgetCloudEmbeddingsProbe();
  return await withApply(async () => {
    const applied: CloudDefaultsApplied = { moved: [], failed: [] };
    // A box with no credential can promote nothing, and this runs at every
    // boot: reading the whole state there would be a voice inventory and an
    // openclaw.json read bought for an answer that is already known.
    if ((await resolveClawaiToken()) === null) return applied;
    let status: CloudDefaultsStatus;
    try {
      status = await readCloudDefaultsStatus();
    } catch (err) {
      console.warn("[clawai-cloud-defaults] could not read the box's current engines:", message(err));
      return applied;
    }
    for (const capability of ["stt", "tts", "embeddings"] as const) {
      const state = status.capabilities[capability];
      // PROMOTE ONLY — see the file's docblock. An owner pick has already been
      // folded into `target`, so this one condition covers both properties.
      //
      // Deliberately NOT also skipping on `state.source === "cloud"`: a
      // capability can be reported as on the cloud and still have a half of it
      // pointing at the box — transcription is TWO settings, and a box whose
      // `stt_primary` has always said cloud can carry a channel audio list that
      // tries the on-device row first. Each promoter below answers whether it
      // wrote anything, so a capability with nothing left to do costs nothing
      // and is not reported as moved.
      if (state.ownerChoice || state.target !== "cloud") continue;
      try {
        if (await promote(capability)) {
          applied.moved.push(capability);
          console.warn(
            `[clawai-cloud-defaults] ${capability} moved to the ClawBox AI cloud (${options.trigger ?? "boot"})`,
          );
        }
      } catch (err) {
        applied.failed.push({ capability, error: message(err) });
        console.warn(`[clawai-cloud-defaults] could not move ${capability} to the cloud:`, message(err));
      }
    }
    return applied;
  });
}

/** Move one capability onto the cloud. Answers whether anything was written. */
async function promote(capability: CloudCapability): Promise<boolean> {
  switch (capability) {
    case "stt":
      return await promoteStt();
    case "tts":
      return await promoteTts();
    case "embeddings":
      return await promoteEmbeddings();
  }
}

/**
 * Speech IN. Two halves and they must agree: the chat microphone reads
 * `stt_primary` per request, and a channel voice note reads the order of
 * `tools.media.models[]`.
 *
 * The gateway is deliberately NOT restarted here. The audio list is read at
 * gateway start, so a box written at boot picks the new order up when the
 * gateway next comes up — and this runs from the web server's own boot, where a
 * restart of the harness the owner may be mid-conversation with is a far worse
 * trade than a channel order that lands a few seconds later. The owner's own
 * change through `/setup-api/stt` still restarts, as it always did.
 */
async function promoteStt(): Promise<boolean> {
  const order = sttEngineOrder("cloud");
  let wrote = false;
  if (!openclawIsAbsent()) {
    const local = await localSttInstalled();
    wrote = await syncChannelAudio(order, local.installed);
  }
  if ((await getSttPrimary()) !== "cloud") {
    await setSttPrimary("cloud");
    wrote = true;
  }
  return wrote;
}

/**
 * Speech OUT. Only ever points at a cloud voice the box actually HAS: on a box
 * whose plan covers it, `gateway-pre-start.sh` is what writes the provider
 * entry, and until it has there is nothing here to select. A pick with no
 * endpoint behind it would answer every utterance with a 401.
 */
async function promoteTts(): Promise<boolean> {
  const harness = await getActiveHarness();
  const [{ config, probe }, state] = await Promise.all([probeBox(harness), readVoiceState()]);
  const status = buildVoiceOutputStatus(config, probe, state);
  const cloud = status.engines.find((engine) => engine.id === "cloud");
  if (!cloud?.configured || !cloud.providerId) return false;
  if (cloud.providerId === status.activeProviderId) return false;
  await writeActiveVoiceProvider(harness, status.engines, cloud.providerId);
  return true;
}

/**
 * MEMORY. The one capability where the switch is not free: provider, model and
 * endpoint together are what the index identity is built from, so moving it
 * invalidates every vector on disk and search fails closed until a rebuild.
 * That rebuild is asked for here, in the same breath — `ensure-local-embeddings.sh`
 * does the same thing for the other direction, and for the same reason.
 *
 * Only on a box whose owner has switched Memory Shard ON: with it off there is
 * no index to invalidate and no pass that would run, so the write would be a
 * gateway restart bought for nothing.
 */
async function promoteEmbeddings(): Promise<boolean> {
  // Already pointed off the box: nothing to write, and writing anyway would
  // invalidate a perfectly good index and buy a reindex for nothing.
  if ((await currentEmbeddingSource()) === "cloud") return false;
  if (!(await getMemoryShardEnabled())) return false;
  const token = await resolveClawaiToken();
  if (!token) return false;
  await switchToCloudEmbeddings(await cloudEmbeddingsUrl(), token);
  invalidateMemoryStatusCache();
  // The rebuild is best-effort and reported separately: the config write has
  // LANDED by now, so a pass that could not start (one already running, the
  // switch flipped underneath) is not a failed switch — the next scheduled pass
  // rebuilds, and the panel shows the mismatched fingerprint meanwhile.
  try {
    const started = await startMemoryIndex("full", "manual");
    if (!started.accepted) {
      console.warn(`[clawai-cloud-defaults] memory reindex declined after the switch: ${started.declined}`);
    }
  } catch (err) {
    console.warn("[clawai-cloud-defaults] memory reindex could not be started after the switch:", message(err));
  }
  return true;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
