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
 *     The memory embedder has one edition-specific twist on that — see
 *     `embeddingsOwnerChoice` — because on the SKU where ClawBox indexes, a
 *     wizard that could only ever post one answer stamped that key on every box
 *     that ran it, so the mark there records a click and not a decision.
 *
 * So the worst this can do on a box that was working is point it at a cloud
 * engine its subscription covers, which is what was asked for; and the most it
 * can do on a box that was not is nothing.
 */

import { readClawaiEntitlementTier } from "@/lib/clawai-plan-tier";
import { clearOwnerChoice, readChoiceSource } from "@/lib/clawai-cloud-choice";
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
import { readEmbedderPin } from "@/lib/memory-embedder";
import { readEmbeddingPlacement, switchToCloudEmbeddings } from "@/lib/memory-shard";
import type { EmbeddingSource } from "@/lib/memory-shard-state";
import { openclawIsAbsent } from "@/lib/openclaw-config";
import { createSerialLock } from "@/lib/serial-lock";
import { syncChannelAudio } from "@/lib/stt-channel";
import { localSttInstalled } from "@/lib/stt-local";
import { getSttPrimary, setSttPrimary, sttEngineOrder, STT_PRIMARY_KEY } from "@/lib/stt-preference";
import { probeBox, writeActiveVoiceProvider, type ActiveHarness } from "@/lib/voice-box";
import { buildVoiceOutputStatus, type VoiceOutputStatus } from "@/lib/voice-output";
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
  // Both editions since 2026-09-18. The fence the old `false` stood for is
  // still there — ClawBox's own index sends the owner's text to the loopback
  // proxy or to this box's ClawBox AI account and nowhere else
  // (`memory-embedder.ts`) — but it is no longer a reason to keep an edition
  // off a subscription it pays for. The fact is kept as a KILL SWITCH (see its
  // own docblock): one `false` here takes every box off the cloud embedder
  // without touching the rule that reads it.
  const embeddingsSupported = true;
  return {
    linked,
    entitlement,
    embeddingsSupported,
    embeddingsRouteReady: await embeddingsRouteReady(linked, entitlement, embeddingsSupported),
  };
}

/**
 * The voice inventory, read ONCE per run and used twice.
 *
 * `probeBox` is not a cheap read: it checks the Kokoro stamp, reads the user
 * service state, can inspect process memory and runs up to two executable
 * checks. `readCloudDefaultsStatus` needs it to say where speech-out comes from
 * today, and `promoteTts` needs the same three answers to write the move — so on
 * every eligible boot and every credential link the box paid for that walk
 * twice. Threaded through the apply run instead.
 *
 * DELIBERATELY NOT a cross-run cache: the local installation state is exactly
 * what changes between runs (install.sh finishes, the owner uninstalls a voice),
 * and a stale snapshot there is an applier writing a provider that is no longer
 * on the box.
 */
interface VoiceSnapshot {
  harness: ActiveHarness;
  status: VoiceOutputStatus;
}

async function readVoiceSnapshot(): Promise<VoiceSnapshot> {
  const harness = await getActiveHarness();
  const [{ config, probe }, state] = await Promise.all([probeBox(harness), readVoiceState()]);
  return { harness, status: buildVoiceOutputStatus(config, probe, state) };
}

/** Which engine speaks for this box right now. */
function voiceSourceOf(status: VoiceOutputStatus): CapabilitySource {
  // The provider actually written, and only when that is neither engine does
  // the resolved preference stand in: a box mid-provisioning has a choice but
  // nothing selected yet, and reporting that as "local" would make the applier
  // think it had work to do.
  return (status.activeEngine ?? status.preferredEngine ?? "local") === "cloud" ? "cloud" : "local";
}

/**
 * Where the memory index is embedded right now.
 *
 * @param fallback the verdict this run already computed, for a box that has
 *   pinned nothing: the default rule is what decides there, and reading the
 *   facts a second time to learn it would buy a second probe.
 */
async function currentEmbeddingSource(fallback: CapabilitySource): Promise<CapabilitySource> {
  return (await readEmbeddingPlacement(fallback)).source;
}

/**
 * Every capability's current engine, what the rule says it should be, and who
 * decided. Read-only — nothing here writes.
 */
export async function readCloudDefaultsStatus(): Promise<CloudDefaultsStatus> {
  return (await readStatusAndVoice()).status;
}

/**
 * The same read, keeping the voice snapshot it already paid for.
 *
 * The applier is the only caller that wants the second half — see
 * {@link VoiceSnapshot}. The exported reader above stays the narrow one, so no
 * panel route has to know a probe object exists.
 */
async function readStatusAndVoice(): Promise<{ status: CloudDefaultsStatus; voice: VoiceSnapshot }> {
  const facts = await readCloudDefaultsFacts();
  const defaults = resolveClawaiCloudDefaults(facts);
  const [stt, voice, embeddings, owners] = await Promise.all([
    getSttPrimary(),
    readVoiceSnapshot(),
    currentEmbeddingSource(defaults.embeddings.source),
    readOwnerChoices(),
  ]);
  const tts = voiceSourceOf(voice.status);
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
  return { status: { linked: facts.linked, plan: facts.entitlement, capabilities }, voice };
}

/**
 * Who chose each capability's engine.
 *
 * The recorded source, and — for a box that predates the key — the one stored
 * value only a person could have produced. See `ownerChoiceFrom`.
 */
async function readOwnerChoices(): Promise<Record<CloudCapability, boolean>> {
  const [ttsSource, sttSource, embedSource, storedStt, voiceState, embedPin] = await Promise.all([
    readChoiceSource("tts"),
    readChoiceSource("stt"),
    readChoiceSource("embeddings"),
    get(STT_PRIMARY_KEY),
    readVoiceState(),
    openclawIsAbsent() ? readEmbedderPin() : Promise.resolve(null),
  ]);
  return {
    tts: ownerChoiceFrom(ttsSource, voiceState.choice === "local"),
    stt: ownerChoiceFrom(sttSource, storedStt === "local"),
    embeddings: embeddingsOwnerChoice(embedSource, embedPin),
  };
}

/**
 * Did the owner choose where the memory index is embedded?
 *
 * ON OPENCLAW the mark is the whole answer, as it is for the other two. Nothing
 * before this feature recorded an embedding pick — the boot script wrote the
 * on-device embedder on every box — so there is no earlier "only a person could
 * have done this" value to grandfather.
 *
 * ON THE EDITION WHERE CLAWBOX INDEXES, THE MARK ALONE IS NOT A CHOICE, and
 * reading it as one is what this fixes. Every Hermes box that finished the
 * Memory Shard wizard before 2026-09-18 carries `memory_embeddings_choice_source:
 * "owner"` — the wizard's last step POSTed the model on this box because it was
 * the only thing the route could offer there, and the route marks every pick as
 * the owner's. Honouring that mark left the whole of that population in the
 * worst of the three states: `resolveMemoryEmbedder` ignores it and started
 * sending their documents to the cloud, while this applier honoured it and so
 * never wrote the pin or asked for the rebuild the move needs — the stored
 * identity stayed the 1,024-dimension local one, `identityOf` read `mismatched`
 * and `searchLocalMemory` answered `[]` silently until some later pass happened
 * to rebuild.
 *
 * THE PIN IS WHAT RECORDS A CHOICE THERE (`memory-embedder.ts` says the same
 * thing from the reader's side), so a mark is honoured only where a pin stands
 * beside it. A box whose owner picks "On this box" through the settings card
 * after this change has both — the route writes the mark and
 * `switchToLocalEmbeddings` writes the pin — and stays local for good.
 */
function embeddingsOwnerChoice(recorded: unknown, pin: EmbeddingSource | null): boolean {
  if (openclawIsAbsent() && pin === null) return false;
  return ownerChoiceFrom(recorded, false);
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
  return await withApply(async () => {
    // INSIDE the lock, not before it. A run already holding the lock can still
    // have an `askCloudEmbedder` call in flight, and that call writes its answer
    // into the probe cache when it lands. Clearing outside meant the clear could
    // happen first and the older run's answer repopulate the cache afterwards —
    // so the credential-change run read a verdict about the PREVIOUS credential
    // and skipped its own probe. When that stale answer was `false`, embeddings
    // stayed on the box for up to `PROBE_FAIL_TTL_MS` after the owner linked a
    // subscription. Here the clear and the next probe cannot be separated.
    if (options.credentialChanged) forgetCloudEmbeddingsProbe();
    const applied: CloudDefaultsApplied = { moved: [], failed: [] };
    // A box with no credential can promote nothing, and this runs at every
    // boot: reading the whole state there would be a voice inventory and an
    // openclaw.json read bought for an answer that is already known.
    if ((await resolveClawaiToken()) === null) return applied;
    let status: CloudDefaultsStatus;
    let voice: VoiceSnapshot;
    try {
      ({ status, voice } = await readStatusAndVoice());
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
        if (await promote(capability, voice)) {
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
async function promote(capability: CloudCapability, voice: VoiceSnapshot): Promise<boolean> {
  switch (capability) {
    case "stt":
      return await promoteStt();
    case "tts":
      return await promoteTts(voice);
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
 *
 * Nothing here re-checks that the box is LINKED, and it does not have to: the
 * caller only reaches a capability whose `target` is the cloud, which for
 * transcription is `facts.linked` itself. What makes a stale `cloud` in the
 * store harmless in the other direction — an owner who unlinks, or a credential
 * the portal revokes — is `resolveSttPrimary`, which will not report the cloud
 * as the engine that hears a box holding no credential for it.
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
 *
 * Works from the run's own {@link VoiceSnapshot} — the same one the status read
 * above was decided from, taken moments earlier inside the same lock — rather
 * than probing the box a second time.
 */
async function promoteTts({ harness, status }: VoiceSnapshot): Promise<boolean> {
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
 * DELIBERATELY NOT GATED ON THE MEMORY SHARD SWITCH, which it was until
 * 2026-09-17. That switch is ClawBox's consent to run index PASSES over the
 * owner's folders; it has never governed which embedder the AGENT searches
 * memory with, and `ensure-local-embeddings.sh` writes the on-device one into
 * `memory.search` at every gateway start with no regard for it. Since the switch
 * is off on a new box, gating here meant every freshly onboarded box that linked
 * a paid subscription kept the local embedder for good while the card said its
 * target was the cloud, with no reason beside it and nothing that would ever
 * move it — voice and transcription flipped, memory did not (measured on three
 * rig boxes, 2026-09-15).
 *
 * With the switch off the rebuild below simply declines `disabled`, which is
 * already handled as the non-failure it is: there is no index to rebuild, and
 * the first pass the owner ever runs then builds under the cloud identity
 * instead of building under the local one and being invalidated at the next
 * boot.
 */
async function promoteEmbeddings(): Promise<boolean> {
  // Already pointed off the box AND WRITTEN DOWN: nothing to write, and writing
  // anyway would invalidate a perfectly good index and buy a reindex for
  // nothing. `recorded` is the second half and it is load-bearing on the
  // edition where ClawBox indexes: there an unpinned box ALREADY embeds in the
  // cloud by default, so reading the source alone would have skipped the one
  // write that records it — and with it the full pass that rebuilds an index
  // whose vectors were made by the model on the box.
  const placement = await readEmbeddingPlacement("cloud");
  if (placement.recorded && placement.source === "cloud") return false;
  const token = await resolveClawaiToken();
  if (!token) return false;
  await switchToCloudEmbeddings(cloudEmbeddingsUrl(), token);
  // THE APPLIER OWNS THIS CAPABILITY NOW, said out loud in the key that records
  // who decided. A legacy Hermes box reaches here carrying `owner` from a wizard
  // that could only ever post one answer (see `embeddingsOwnerChoice`); leaving
  // that word in place would have the card report an owner choice for a move the
  // owner never made. `auto` is the truthful value and the one `clearOwnerChoice`
  // exists to write. It is not what stops a second promotion — the PIN this
  // switch just wrote is, through `placement.recorded` above — so a write that
  // fails here costs nothing but the label.
  await clearOwnerChoice("embeddings").catch((err) => {
    console.warn("[clawai-cloud-defaults] could not record who chose the embedder:", message(err));
  });
  invalidateMemoryStatusCache();
  // The rebuild is best-effort and reported separately: the config write has
  // LANDED by now, so a pass that could not start (one already running, the
  // switch flipped underneath) is not a failed switch — the next scheduled pass
  // rebuilds, and the panel shows the mismatched fingerprint meanwhile.
  try {
    const started = await startMemoryIndex("full", "manual");
    // `disabled` is not worth a warning line: it is the expected answer on a box
    // whose owner has not switched Memory Shard on, where there is no index to
    // rebuild in the first place. `running` is the one worth saying out loud.
    if (!started.accepted && started.declined !== "disabled") {
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
