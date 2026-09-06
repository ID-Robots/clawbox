// "Did the OWNER choose this model, or did we fill one in for them?"
//
// WHY IT EXISTS (TASK-713). The ClawBox AI tier badge is a device DEFAULT — the
// portal's `deviceTier`, which a Max subscriber may deliberately leave on Flash
// for one box — and every pair, re-pair, wizard finalise and plan press wrote
// `CLAWBOX_AI_MODEL_BY_TIER[badge]` straight over the primary model. On a Max
// account whose box is stamped `flash`, an entitled Max primary was replaced by
// Flash on the next re-pair, and the chat's own entitlement guard could not undo
// it: that one only ever moves DOWN. The owner's ruling is that a default fills
// a gap and never overwrites a choice.
//
// WHY IT CANNOT BE ANSWERED FROM THE REQUEST. A re-pair reaches the configure
// route through `ai-models/clawai/poll`, which sends `clawaiTier: session.tier`
// — the same field the plan cards send. The two are indistinguishable on the
// wire, so "was a tier named?" cannot be the test. What the box CAN know is the
// other half: whether the owner has ever picked a ClawBox AI model themselves.
// That is what this records.
//
// WHY THERE IS NO INFERENCE FROM THE RUNNING MODEL, and why nobody should add
// one back. An earlier revision read "the primary is a ClawBox AI model and is
// not the one the badge implies" as evidence of a choice. It is not: the badge
// and the model move at different times. `/setup-api/ai-models/status` persists
// a new portal tier on its 30-second poll while nothing rewrites the model until
// the next configure, so the FIRST configure after any plan change sees exactly
// that mismatch. It would mint a Flash "pick" on an upgrade — the customer pays
// for Max and the box can never default to it again — and a Max "pick" on a
// downgrade, which the plan then refuses on every turn while the chat guard
// drops it back and the next re-pair re-breaks it. A pick is recorded where a
// pick is MADE, or not at all.
//
// WHAT IS NOT A PICK. A switch the BOX made — the chat's entitlement guard
// dropping a refused Max model to Flash — is not the owner choosing Flash, and
// recording it would pin the box there for good. Those writes carry
// `automatic: true`. Nor is a model DERIVED from a provider-only switch: "make
// ClawBox AI the default" and the MCP `ai_set_provider` tool both resolve the
// provider's own recommended model, which is another default.
//
// HARNESS-FIRST. There is nothing native to borrow, but the reason is narrower
// than "the core does not touch the primary". OpenClaw's sticky model selection
// (`modelSelectionScope`, default `"effective"`, which ClawBox never sets) DOES
// propagate an owner's session pick into `agents.defaults.model.primary` when
// `modelOverrideSource === "user"` — it simply records no provenance where it
// lands, and the session-scoped source it came from is deleted once the override
// equals the agent default. So the primary itself can never be asked "did the
// owner choose this?". Hermes' `model.default` carries no provenance either; the
// portal publishes a per-device `deviceTier` (a default) and `allowedModels`
// (the entitlement, which `portalDeniesClawboxAiModel` already honours) but no
// per-device model. The marker is ClawBox's own, in ClawBox's own store, beside
// `clawai_tier`.
//
// WHAT THAT LEAVES UNCOVERED, stated rather than left silent: a pick made
// through OPENCLAW'S OWN surfaces — its Control UI picker, the core's Telegram
// `/model` keyboard, `openclaw models set` — reaches the primary without passing
// any ClawBox route, so nothing records it here and a later re-pair still writes
// the badge default over it. That is beta's behaviour, unchanged by this file;
// closing it needs either a provenance field the core does not have or a read of
// the core's session store at pair time, and it is out of scope for this card.

import { getKnown, setMany } from "@/lib/config-store";
import { CLAWBOX_AI_CHAT_MODEL_IDS, CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

/**
 * Config-store key: `{ <canonical provider>: <model as the picker wrote it> }`.
 *
 * PER PROVIDER, not one slot for the box. The readers each ask a
 * provider-specific question ("which ClawBox AI model did the owner choose"),
 * and a single slot answered it wrong in the obvious case: pick ClawBox AI Max,
 * try Anthropic for a day, re-pair ClawBox AI — the Anthropic pick is not a
 * ClawBox AI answer, so the badge would overwrite a Max choice nobody revoked.
 *
 * The provider keys are the canonical UI ids (`clawai`, `anthropic`, …), and the
 * values keep the spelling the surface that wrote them uses:
 * `deepseek/deepseek-v4-pro` from the OpenClaw picker, the bare
 * `deepseek-v4-pro` from Hermes, whose config takes ids unprefixed.
 */
export const EXPLICIT_MODEL_PICKS_KEY = "ai_model_explicit_picks";

/** Canonical provider id -> the model reference the owner chose for it. */
export type ExplicitModelPicks = Record<string, string>;

/**
 * Writes are serialised through this chain.
 *
 * One KEY holds every provider's pick, and storing it is a read-modify-write:
 * two model switches in flight together — a picker click while a promote is
 * still settling — would each read the map, add their own slot and write their
 * own snapshot, and the loser's provider would be dropped. Two separate config
 * keys could not lose each other that way; one map can, which is the cost of
 * keying by provider inside a single value.
 *
 * In-process is the whole of the problem here: the Next server is the only
 * writer of this key, and `data/config.json` has no inter-process lock to take
 * (its `set`/`setMany` carry the same unlocked read-modify-write for every
 * other key on beta).
 */
let writeChain: Promise<void> = Promise.resolve();

/** Run a read-modify-write on the picks map without another one interleaving. */
function serialise(fn: () => Promise<void>): Promise<void> {
  const next = writeChain.then(fn, fn);
  // Never leaves a rejected promise as the chain head: the next writer would
  // inherit it and the whole key would stop being written for the process
  // lifetime. Each caller handles its own failure.
  writeChain = next.then(() => {}, () => {});
  return next;
}

/**
 * The ClawBox AI chat model this reference names, bare, or null.
 *
 * The id allowlist is what actually decides — `CLAWBOX_AI_CHAT_MODEL_IDS` is a
 * closed set of two. The provider half is checked only to reject a foreign
 * vendor that happens to serve a same-named id, which is not idle: OpenRouter
 * slugs carry their vendor INSIDE the id, and `deepseek/` is one of them.
 */
export function clawboxAiModelIdOf(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  const provider = slash === -1 ? null : trimmed.slice(0, slash).trim().toLowerCase();
  const id = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  // `clawai` is the UI's name for the provider openclaw.json calls `deepseek`;
  // both spellings reach this from different surfaces.
  if (provider && provider !== CLAWBOX_AI_PROVIDER && provider !== "clawai") return null;
  return (CLAWBOX_AI_CHAT_MODEL_IDS as readonly string[]).includes(id) ? id : null;
}

/**
 * The shape every provider id this file will key by has: a letter, then letters,
 * digits or hyphens (`clawai`, `openrouter`, `openai-codex`, `kimi-coding`).
 *
 * The slot is derived from a model reference that arrives in a REQUEST BODY and
 * is then used as a property name, so it is validated rather than trusted: an
 * unbounded key would put whatever the caller sent into `data/config.json`, and
 * a name like `__proto__` or `constructor` has meaning to an object before it
 * has meaning to us. Anything outside this shape is simply not a slot, and the
 * pick is not recorded.
 */
const PROVIDER_SLOT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_SLOTS: ReadonlySet<string> = new Set(["constructor", "prototype", "__proto__"]);

function isProviderSlot(slot: string): boolean {
  return PROVIDER_SLOT_RE.test(slot) && !RESERVED_SLOTS.has(slot);
}

/**
 * Which provider slot a model reference belongs in.
 *
 * ClawBox AI's two spellings collapse onto `clawai`; everything else is keyed by
 * the vendor prefix it carries, and a reference with no prefix at all (a local
 * model id) is not a provider choice this file has anything to say about.
 */
function pickSlotFor(ref: string): string | null {
  if (clawboxAiModelIdOf(ref)) return "clawai";
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const slot = ref.slice(0, slash).trim().toLowerCase();
  return isProviderSlot(slot) ? slot : null;
}

/** The stored map, tolerant of anything that is not one — the store is hand-editable JSON. */
export function explicitPicksFrom(raw: unknown): ExplicitModelPicks {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const picks: ExplicitModelPicks = {};
  for (const [provider, model] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProviderSlot(provider)) continue;
    if (typeof model === "string" && model.trim()) picks[provider] = model.trim();
  }
  return picks;
}

export interface ClawboxAiModelDecision {
  /** The BARE model id a pair, re-pair or tier change must write. */
  modelId: string;
  /** True when it is the owner's own choice rather than the tier default. */
  explicit: boolean;
}

/**
 * Which ClawBox AI model to write, and whether the owner chose it.
 *
 * No I/O and no inference: the only thing that outranks the badge is a recorded
 * pick for THIS provider. An unreadable store therefore lands on the badge, the
 * same answer beta gave — a pair that writes no model at all is a box with no
 * working chat, and bookkeeping we could not read is not worth holding a save
 * hostage to.
 */
export function decideClawboxAiModelId(opts: {
  picks: ExplicitModelPicks;
  /** The bare id the tier badge implies. */
  tierModelId: string;
}): ClawboxAiModelDecision {
  const picked = clawboxAiModelIdOf(opts.picks.clawai);
  return picked
    ? { modelId: picked, explicit: true }
    : { modelId: opts.tierModelId, explicit: false };
}

/**
 * Write down that the owner chose this model.
 *
 * Called from the surfaces an owner presses, and only when the request NAMED a
 * model — a provider-only switch resolves that provider's own recommended
 * default, which is not a choice.
 *
 * FAIL-SOFT, deliberately. This is bookkeeping: losing it costs one overwrite by
 * the badge, while throwing costs a model change that has already landed on
 * disk. `setMany` reads the store strictly and throws on a `data/config.json`
 * left root-owned by a sudo script — a real state on these boxes — and every
 * call site sits after the write it describes.
 */
export async function recordExplicitModelPick(model: string): Promise<void> {
  const trimmed = model.trim();
  const slot = trimmed ? pickSlotFor(trimmed) : null;
  if (!slot) return;
  return serialise(async () => {
    try {
      const { value } = await getKnown(EXPLICIT_MODEL_PICKS_KEY);
      // `explicitPicksFrom` has already dropped every key that is not a provider
      // slot, and `slot` itself came through `isProviderSlot`, so the property
      // name written here is one of a bounded, known shape.
      const picks = explicitPicksFrom(value);
      picks[slot] = trimmed;
      await setMany({ [EXPLICIT_MODEL_PICKS_KEY]: picks });
    } catch (err) {
      console.warn(
        "[explicit-model-pick] could not record the owner's model pick:",
        err instanceof Error ? err.message : err,
      );
    }
  });
}

/** The stored picks, for a caller that has not already loaded the whole store. */
export async function readExplicitModelPicks(): Promise<ExplicitModelPicks> {
  const { value } = await getKnown(EXPLICIT_MODEL_PICKS_KEY);
  return explicitPicksFrom(value);
}
