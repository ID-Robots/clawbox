/**
 * Which of the three speech-and-memory capabilities this box should default to
 * the ClawBox AI cloud for, and which to the engine on its own disk.
 *
 * The owner's decision of 2026-09-14: "Default TTS, STT and embeddings models
 * are from the ClawBox AI subscription cloud if the user has them or connects a
 * ClawBox AI subscription." Local stays the fallback for a box with no
 * subscription — and stays selectable, which is the half this module is written
 * around: an automatic default that could overwrite a pick the owner made would
 * be a setting the box takes back.
 *
 * CLIENT-SAFE ON PURPOSE. The resolver is a pure function of four facts so the
 * Local AI panel can explain the same verdict the server applies, without
 * pulling the config store, the OpenClaw CLI or `node:child_process` into the
 * desktop bundle. The server half — reading those facts, and writing the
 * settings that follow from them — is `@/lib/clawai-cloud-defaults`. Same split
 * as `memory-shard-state.ts` and `coding-permission-rules.ts`.
 */

import type { ClawboxAiPlanTier } from "@/lib/clawbox-ai-models";

/** The three capabilities the owner's decision names. */
export type CloudCapability = "tts" | "stt" | "embeddings";

/** Where a capability is served from. */
export type CapabilitySource = "cloud" | "local";

/** Who decided it: the owner in as many words, or this resolver. */
export type ChoiceSource = "owner" | "auto";

export const CLOUD_CAPABILITIES: readonly CloudCapability[] = ["tts", "stt", "embeddings"];

/**
 * Where each capability records WHO chose its engine.
 *
 * A separate key per capability rather than one object, because the three are
 * written by three different routes at three different moments and a
 * read-modify-write of a shared object would let the later writer drop the
 * earlier one's answer.
 *
 * An ABSENT key is "nobody has said", which is what lets the auto-default move
 * a box that has never been asked. See `ownerChoiceFrom` for the one case where
 * an absent key still has to read as the owner's.
 */
export const CHOICE_SOURCE_KEYS: Readonly<Record<CloudCapability, string>> = {
  tts: "tts_choice_source",
  stt: "stt_choice_source",
  embeddings: "memory_embeddings_choice_source",
};

/**
 * The tier the proxy serves cloud SPEECH to — internal `pro`, which is the MAX
 * plan; the marketed and internal names are off by one on purpose (see
 * `CLAWBOX_AI_MODEL_BY_TIER` in clawbox-ai-models.ts). The gate itself lives in
 * `scripts/gateway-pre-start.sh` as `CLAWBOX_SPEECH_DEVICE_TIER`; this is the
 * TypeScript half of the same constant and the suite pins the two.
 */
export const CLOUD_TTS_ENTITLED_TIER = "pro";

/** Why a capability is NOT on the cloud. Each one has a different fix. */
export type CloudUnavailableReason =
  /** No ClawBox AI credential on this box at all. */
  | "not_linked"
  /** Linked, but the plan on record does not include this capability. */
  | "plan"
  /** The proxy route this capability needs did not answer. */
  | "route_unavailable"
  /**
   * This box cannot use the cloud for it at all.
   *
   * No edition answers this today — `embeddingsSupported` is a constant `true`
   * — and the word is kept because that fact is the feature's kill switch: a
   * build that flips it needs this reason, its note key and the card's branch
   * to be there already, not written under a live incident.
   */
  | "edition"
  /** The owner picked the engine on the box. */
  | "owner";

/** Everything the verdict depends on, gathered by the server half. */
export interface CloudDefaultsFacts {
  /** A ClawBox AI credential is on the box. */
  linked: boolean;
  /**
   * The entitlement tier — the PLAN when the portal has told us one, the device
   * badge only when it has not (`clawaiEntitlementTier`). `null` is "nobody has
   * told us", which is never read as an entitlement.
   */
  entitlement: ClawboxAiPlanTier | null;
  /** `POST <proxy>/embeddings` answered an embedding. */
  embeddingsRouteReady: boolean;
  /**
   * This box can point its memory index off the device at all.
   *
   * TRUE ON EVERY EDITION SINCE 2026-09-18, and kept as a fact rather than
   * deleted because it is the KILL SWITCH for the whole feature: its only
   * producer (`readCloudDefaultsFacts`) is one line, and a `false` there takes
   * every box off the cloud embedder — with the `"edition"` reason already
   * worded in all ten locales — without touching this rule or any caller.
   *
   * It used to be false where ClawBox itself is the indexer, because that
   * client accepted a loopback endpoint and nothing else. It now accepts
   * exactly two — the loopback proxy and the ClawBox AI endpoint the image was
   * built with (`memory-embedder.ts`) — so the fence is still a fence and the
   * SKU is no longer a reason to keep a subscriber off what they pay for.
   */
  embeddingsSupported: boolean;
}

/** One capability's verdict. */
export interface CapabilityVerdict {
  /** What this box should default to. */
  source: CapabilitySource;
  /** Why it is not the cloud, or null when it is. */
  reason: CloudUnavailableReason | null;
}

export type CloudDefaults = Readonly<Record<CloudCapability, CapabilityVerdict>>;

const CLOUD: CapabilityVerdict = { source: "cloud", reason: null };

function local(reason: CloudUnavailableReason): CapabilityVerdict {
  return { source: "local", reason };
}

/** A plan that is paid for — `free` is the portal's word for an unpaid one. */
function paid(entitlement: ClawboxAiPlanTier | null): boolean {
  return entitlement === "flash" || entitlement === "pro";
}

/**
 * What this box should default to, per capability. PURE.
 *
 * The three rules are deliberately not the same, because the three capabilities
 * are not sold the same way:
 *
 *  - STT is served to ANY connected box, unpaid plan included — the proxy's
 *    transcription route has no tier gate, and `stt_primary` has shipped
 *    defaulting to `cloud` since the feature existed.
 *  - TTS is Max-only on the proxy, which answers 403 to Free and Pro. Pointing
 *    an unentitled box at it would be worse than leaving it alone: every spoken
 *    reply would pay a failed round trip before falling back to the voice the
 *    box already has.
 *  - EMBEDDINGS need a paid plan and a proxy route that answers. Unknown
 *    entitlement is LOCAL here rather than cloud, because moving the index off
 *    the device invalidates its fingerprint and costs a full reindex — not
 *    something to spend on a guess.
 */
export function resolveClawaiCloudDefaults(facts: CloudDefaultsFacts): CloudDefaults {
  return {
    stt: facts.linked ? CLOUD : local("not_linked"),
    tts: !facts.linked
      ? local("not_linked")
      : facts.entitlement === CLOUD_TTS_ENTITLED_TIER
        ? CLOUD
        : local("plan"),
    embeddings: !facts.linked
      ? local("not_linked")
      : !facts.embeddingsSupported
        ? local("edition")
        : !paid(facts.entitlement)
          ? local("plan")
          : facts.embeddingsRouteReady
            ? CLOUD
            : local("route_unavailable"),
  };
}

/**
 * Did the OWNER choose this engine?
 *
 * The recorded source when there is one — every surface that lets a person pick
 * writes `owner` beside the pick. And, when there is NONE, a stored setting that
 * only a person could have produced: on every box shipped before this module
 * existed, nothing but the owner's own click wrote `local` into `stt_primary` or
 * into the voice choice. Reading those as "nobody has said" would make the first
 * boot after an update undo a decision the owner made months ago, silently,
 * which is precisely the failure the source key exists to prevent.
 *
 * @param recorded the value of this capability's key in the config store.
 * @param storedIsLocalPick the box already holds an explicit on-device pick for
 *   this capability, made through a surface that predates the source key.
 */
export function ownerChoiceFrom(recorded: unknown, storedIsLocalPick: boolean): boolean {
  if (recorded === "owner") return true;
  if (recorded === "auto") return false;
  return storedIsLocalPick;
}
