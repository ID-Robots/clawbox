import { get } from "@/lib/config-store";
import {
  CLAWBOX_AI_MUSIC_TIER,
  normalizeClawboxAiPlanTier,
  type ClawboxAiPlanTier,
} from "@/lib/clawbox-ai-models";

/**
 * Which ClawBox AI media features this box has been switched onto. SERVER ONLY.
 *
 * Each media kind the proxy's shared media route serves is rolled out behind a
 * flag of its own, OFF unless the store names it, so a box never advertises a
 * tool the proxy cannot answer yet. The flag lives in the device store
 * (`data/config.json`) rather than in an environment variable because two of
 * its readers are not this process: `scripts/gateway-pre-start.sh` arms and
 * withdraws the OpenClaw music provider at every gateway start, and the web
 * app and the root boot script do not share an environment — the store is the
 * one place both already read (`clawai_plan_tier` lives beside it).
 *
 * Turning a flag off is the rollback: the next save or gateway start takes back
 * every field ClawBox wrote for that kind, and nothing an owner configured.
 */

/** The store key. An array of flag words, or a comma list when hand-edited. */
export const CLAWAI_MEDIA_FLAGS_KEY = "clawai_media_flags";

/**
 * Every flag word this build knows.
 *   - `music`: OpenClaw's `music_generate`, and the MCP `generate_music` tool on
 *     Hermes, through the proxy's media route. Max only.
 *   - `video_frames`: video understanding by sampling frames and sending them to
 *     the vision model the box already uses — no new provider.
 * Video GENERATION has no flag yet: it is deferred, and will get one when the
 * proxy's media route serves it.
 */
export const CLAWAI_MEDIA_FLAG_WORDS = ["music", "video_frames"] as const;

export type ClawaiMediaFlag = (typeof CLAWAI_MEDIA_FLAG_WORDS)[number];

/**
 * The flags a stored value switches on.
 *
 * Unknown words are ignored rather than refused, the way `CLAWBOX_RUN_MEDIA`
 * is read: a store written by a newer build must not switch anything on here,
 * and must not switch off what this build does know. Case and whitespace are
 * forgiven because the store is hand-edited on a lab box.
 */
export function parseClawaiMediaFlags(value: unknown): ReadonlySet<ClawaiMediaFlag> {
  const words: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const known = new Set<string>(CLAWAI_MEDIA_FLAG_WORDS);
  const flags = new Set<ClawaiMediaFlag>();
  for (const word of words) {
    if (typeof word !== "string") continue;
    const normalized = word.trim().toLowerCase();
    if (known.has(normalized)) flags.add(normalized as ClawaiMediaFlag);
  }
  return flags;
}

/**
 * The flags as they sit in the store; none when the store cannot be read.
 *
 * Failing closed is the safe direction for an ARM — no flag, no new tool — and
 * the withdraw callers only ever take back fields that are positively ours.
 */
export async function readClawaiMediaFlags(): Promise<ReadonlySet<ClawaiMediaFlag>> {
  try {
    return parseClawaiMediaFlags(await get(CLAWAI_MEDIA_FLAGS_KEY));
  } catch {
    return new Set();
  }
}

/**
 * ARM side: may this box be GIVEN the ClawBox AI music provider?
 *
 * The flag, then the plan — `clawaiEntitlementTier`'s answer, which falls back
 * to the device badge while the plan has never been recorded. The cloud voice's
 * arm rule, for the same reason: arming writes only our own fields, and the next
 * boot takes them back once the plan is on record.
 */
export function clawaiMusicArmable(
  flags: ReadonlySet<ClawaiMediaFlag>,
  entitlementTier: ClawboxAiPlanTier | null,
): boolean {
  return flags.has("music") && entitlementTier === CLAWBOX_AI_MUSIC_TIER;
}

/**
 * WITHDRAW side: must the ClawBox AI music provider be TAKEN BACK?
 *
 * When the flag is off — that is the rollback — or when the RECORDED plan is
 * positively not Max. Never on the badge: a Max subscriber may run their box
 * on Flash, and not knowing the plan is not a downgrade (see
 * `clawaiSpeechWithdrawable`, the same rule for the cloud voice).
 *
 * Either way only fields that are positively ours are taken; the callers decide
 * that, not this predicate.
 */
export function clawaiMusicWithdrawable(
  flags: ReadonlySet<ClawaiMediaFlag>,
  planTier: unknown,
): boolean {
  if (!flags.has("music")) return true;
  const plan = normalizeClawboxAiPlanTier(planTier);
  return plan !== null && plan !== CLAWBOX_AI_MUSIC_TIER;
}
