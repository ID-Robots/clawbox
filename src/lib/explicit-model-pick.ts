// "Did the OWNER choose this model, or did we fill one in for them?"
//
// WHY IT EXISTS (TASK-713). The ClawBox AI tier badge is a device DEFAULT —
// the portal's `deviceTier`, which a Max subscriber may deliberately leave on
// Flash for one box — and every pair, re-pair and wizard finalise wrote
// `CLAWBOX_AI_MODEL_BY_TIER[badge]` straight over
// `agents.defaults.model.primary`. On a Max account whose box is stamped
// `flash`, an entitled Max primary was replaced by Flash on the next re-pair,
// and the chat's own entitlement guard could not undo it: that one only ever
// moves DOWN. The owner's ruling is that a default fills a gap and never
// overwrites a choice.
//
// WHY IT CANNOT BE ANSWERED FROM THE REQUEST. A re-pair reaches the configure
// route through `ai-models/clawai/poll`, which sends `clawaiTier:
// session.tier` — the same field the plan cards send. The two are
// indistinguishable on the wire, so "was a tier named?" cannot be the test.
// What the box CAN know is the other half: whether the owner has ever picked a
// ClawBox AI model themselves. That is what this records.
//
// WHAT IS NOT A PICK. A switch the BOX made — the chat's entitlement guard
// dropping a refused Max model to Flash — is not the owner choosing Flash, and
// recording it would pin the box there for good. Those writes carry
// `automatic: true` and are not recorded.

import { get as getConfigValue, setMany } from "@/lib/config-store";
import { CLAWBOX_AI_CHAT_MODEL_IDS, CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

/**
 * Config-store key holding the last model the owner chose themselves, as the
 * picker wrote it — `deepseek/deepseek-v4-pro` on OpenClaw, the bare
 * `deepseek-v4-pro` on Hermes, whose config takes ids unprefixed.
 *
 * One key for every provider, not one per provider: the question it answers is
 * "what did the owner last choose", and the readers below decide for themselves
 * whether that answer is about them.
 */
export const EXPLICIT_MODEL_PICK_KEY = "ai_model_explicit_pick";

/**
 * The ClawBox AI chat model this reference names, bare, or null when it names
 * something else.
 *
 * The provider half is CHECKED rather than stripped. `openrouter/…` slugs keep
 * a vendor inside the id, so a bare "does the last segment match" test would
 * one day read an OpenRouter row as a ClawBox AI pick and pin a re-pair to it.
 */
export function clawboxAiModelIdOf(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  const provider = slash === -1 ? null : trimmed.slice(0, slash).trim().toLowerCase();
  const id = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  // `clawai` is the UI's name for the same provider openclaw.json calls
  // `deepseek`; both spellings reach this from different surfaces.
  if (provider && provider !== CLAWBOX_AI_PROVIDER && provider !== "clawai") return null;
  return (CLAWBOX_AI_CHAT_MODEL_IDS as readonly string[]).includes(id) ? id : null;
}

export interface ClawboxAiModelDecision {
  /** The BARE model id a pair/re-pair/tier change must write. */
  modelId: string;
  /** True when it is the owner's own choice rather than the tier default. */
  explicit: boolean;
  /**
   * Set when the pick was inferred from the model the box is already running
   * and has to be written down — see the migration note on
   * {@link decideClawboxAiModelId}. The caller records it; this function is
   * pure so both editions can share it without either owning the store.
   */
  migrate: string | null;
}

/**
 * Which ClawBox AI model to write, and whether the owner chose it.
 *
 * THE MIGRATION. Boxes in the field are in exactly the state this card is
 * about and carry no marker, because none existed: a primary that is a ClawBox
 * AI model and is NOT the one the badge implies can only have got there by
 * someone choosing it — the chat picker, the Telegram `/model` keyboard, an
 * `openclaw config set`. Reading that as the explicit pick is what stops the
 * very next re-pair from being the thing that discovers the marker too late.
 * It is deliberately narrow: a primary that EQUALS the tier default is no
 * evidence of anything, and a primary belonging to another provider is not a
 * ClawBox AI choice at all.
 */
export function decideClawboxAiModelId(opts: {
  /** `EXPLICIT_MODEL_PICK_KEY` as the config store holds it. */
  storedPick: unknown;
  /** What the box runs today — `agents.defaults.model.primary`, or Hermes' `model.default`. */
  currentPrimary: string | null | undefined;
  /** The bare id the tier badge implies. */
  tierModelId: string;
}): ClawboxAiModelDecision {
  const picked = clawboxAiModelIdOf(opts.storedPick);
  if (picked) return { modelId: picked, explicit: true, migrate: null };
  // A pick that names another provider is an ANSWER — the owner's last choice
  // simply was not about ClawBox AI — so the migration below must not run for
  // it. Only the absence of any pick leaves the question open.
  if (typeof opts.storedPick === "string" && opts.storedPick.trim()) {
    return { modelId: opts.tierModelId, explicit: false, migrate: null };
  }
  const running = clawboxAiModelIdOf(opts.currentPrimary);
  if (running && running !== opts.tierModelId) {
    // Recorded as the box spells it, not as this function parsed it: the
    // marker is the same field a picker writes, and one shape per edition is
    // what makes it readable by a person looking at data/config.json.
    return { modelId: running, explicit: true, migrate: String(opts.currentPrimary).trim() };
  }
  return { modelId: opts.tierModelId, explicit: false, migrate: null };
}

/**
 * Write down that the owner chose this model.
 *
 * Called from the model pickers — the ones an owner presses — and from the
 * migration above. Never from a switch the box made for itself.
 */
export async function recordExplicitModelPick(model: string): Promise<void> {
  const trimmed = model.trim();
  if (!trimmed) return;
  await setMany({ [EXPLICIT_MODEL_PICK_KEY]: trimmed });
}

/** The stored pick, for a caller that has not already loaded the whole store. */
export async function readExplicitModelPick(): Promise<string | null> {
  const raw = await getConfigValue(EXPLICIT_MODEL_PICK_KEY).catch(() => null);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}
