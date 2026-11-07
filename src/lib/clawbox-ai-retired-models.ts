/**
 * The ClawBox AI model ids the box no longer writes, and the one rule that
 * moves a slot off them (TASK-2261).
 *
 * ClawBox AI is ONE model now: `deepseek-v4-flash` (DeepSeek V4.1 Flash), for
 * chat and for looking at pictures — see src/lib/clawbox-ai-models.ts. Boxes in
 * the field still name the ids it replaced:
 *
 *   - `deepseek-v4-pro`, the Max plan's chat id. The proxy answered it with the
 *     same Flash model; it was a plan gate, never a bigger model.
 *   - `deepseek-v4-flash-vision-exp` and, before it, `gpt-5.6-luna`: the
 *     separate vision model `agents.defaults.imageModel` (OpenClaw) and
 *     `auxiliary.vision` (Hermes) were pointed at.
 *
 * This module is the only place outside the boot script's mirror
 * (scripts/gateway-pre-start.sh) that spells them, so a grep for a retired id
 * finds migration code and its tests and nothing else.
 *
 * WHICH SLOTS ARE OURS. A value is moved only when it names one of these ids
 * under ClawBox AI's own provider — `deepseek/…` or `clawai/…` on OpenClaw, a
 * bare id under `provider: clawai` on Hermes. `gpt-5.6-luna` is also a real
 * OpenAI model: `openai/gpt-5.6-luna`, or a Hermes slot whose provider is not
 * `clawai`, is the owner's configuration and is never touched. Anything else
 * an owner wrote into a slot stays as it is.
 */
import { CLAWBOX_AI_FLASH_MODEL_ID, CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

/** The chat ids ClawBox AI used to offer beside Flash. */
export const RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS: readonly string[] = ["deepseek-v4-pro"];

/** The separate vision ids `imageModel` / `auxiliary.vision` used to name. */
export const RETIRED_CLAWBOX_AI_VISION_MODEL_IDS: readonly string[] = [
  "deepseek-v4-flash-vision-exp",
  "gpt-5.6-luna",
];

/** The Hermes provider slug ClawBox AI is registered under. */
const HERMES_CLAWAI_PROVIDER = "clawai";

/** Claude Code's context-size suffix (`deepseek-v4-pro[1m]`), kept across a move. */
const CONTEXT_SUFFIX = /\[[^\]]*\]$/;

interface ParsedRef {
  /** `deepseek`, `clawai`, or null for a bare id. */
  provider: string | null;
  id: string;
  suffix: string;
}

function parseRef(value: unknown): ParsedRef | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const suffix = CONTEXT_SUFFIX.exec(trimmed)?.[0] ?? "";
  const body = suffix ? trimmed.slice(0, -suffix.length) : trimmed;
  const slash = body.indexOf("/");
  if (slash === -1) return { provider: null, id: body, suffix };
  return { provider: body.slice(0, slash).toLowerCase(), id: body.slice(slash + 1), suffix };
}

function isOurProvider(provider: string, options: RetiredRefOptions): boolean {
  if (provider === HERMES_CLAWAI_PROVIDER) return true;
  return provider === CLAWBOX_AI_PROVIDER && options.deepseekIsClawboxAi !== false;
}

export interface RetiredRefOptions {
  /**
   * Is openclaw.json's `deepseek` provider the ClawBox AI proxy? It is on every
   * box ClawBox provisioned; it is NOT on one an installer pointed at
   * api.deepseek.com with a raw DeepSeek key, where `deepseek/deepseek-v4-pro`
   * is DeepSeek's own model and the owner's choice. Defaults to true.
   */
  deepseekIsClawboxAi?: boolean;
  /** Accept a bare id (Hermes slots, the picks store, a CLI override). Default false. */
  bare?: boolean;
}

function retiredKind(value: unknown, options: RetiredRefOptions): "chat" | "vision" | null {
  const ref = parseRef(value);
  if (!ref) return null;
  if (ref.provider === null ? !options.bare : !isOurProvider(ref.provider, options)) return null;
  if (RETIRED_CLAWBOX_AI_CHAT_MODEL_IDS.includes(ref.id)) return "chat";
  // A vision id never carried a context suffix; one that does is not ours.
  if (!ref.suffix && RETIRED_CLAWBOX_AI_VISION_MODEL_IDS.includes(ref.id)) return "vision";
  return null;
}

/** Does `value` name a retired ClawBox AI CHAT model (the former Max-plan id)? */
export function isRetiredClawboxAiChatModel(value: unknown, options: RetiredRefOptions = {}): boolean {
  return retiredKind(value, options) === "chat";
}

/** Does `value` name one of the retired ClawBox AI VISION models? */
export function isRetiredClawboxAiVisionModel(value: unknown, options: RetiredRefOptions = {}): boolean {
  return retiredKind(value, options) === "vision";
}

/** Either kind: a value the one-model migration moves to Flash. */
export function isRetiredClawboxAiModel(value: unknown, options: RetiredRefOptions = {}): boolean {
  return retiredKind(value, options) !== null;
}

/**
 * The Flash spelling of a retired ref, in the SAME shape it came in: the
 * provider prefix (`deepseek/`, `clawai/`, none) and a context suffix carry
 * over, so `deepseek/deepseek-v4-pro` becomes `deepseek/deepseek-v4-flash` and
 * a bare Hermes id stays bare. `value` must be retired (see the predicates).
 */
export function flashRefFor(value: string): string {
  const ref = parseRef(value);
  if (!ref) return CLAWBOX_AI_FLASH_MODEL_ID;
  const prefix = ref.provider === null ? "" : `${ref.provider}/`;
  return `${prefix}${CLAWBOX_AI_FLASH_MODEL_ID}${ref.suffix}`;
}

/* ---------------------------------------------------------------------------
 * OpenClaw: every model slot under `agents`
 * ------------------------------------------------------------------------ */

export interface OpenclawAgentsMigration {
  /** The migrated `agents` block (a copy; the input is not modified). */
  agents: unknown;
  /**
   * The dotted paths under `agents` whose value changed, at the depth a
   * `config set` can write them whole (`agents.defaults.model`,
   * `agents.defaults.imageModel`, `agents.list`, …). Empty when nothing moved.
   */
  changedPaths: string[];
}

/**
 * Move every slot under openclaw.json's `agents` that names a retired ClawBox
 * AI id to Flash: the primary and its fallbacks, `imageModel`, per-agent
 * models in `agents.list`, `compaction.model`, `modelPolicy.allow`, and a key
 * of the `agents.defaults.models` map. ANY string in the block that is exactly
 * a retired ref is ours (it names ClawBox AI's provider and an id only ClawBox
 * ever wrote), so the walk does not need to know OpenClaw's whole schema.
 *
 * A list that ends up naming Flash twice keeps the first; a map key moved onto
 * a key that already exists yields to it (the owner's Flash entry wins).
 */
export function migrateRetiredClawboxAiOpenclawAgents(
  agents: unknown,
  options: RetiredRefOptions = {},
): OpenclawAgentsMigration {
  const refOptions: RetiredRefOptions = { ...options, bare: false };
  const changed = new Set<string>();

  const walk = (value: unknown, path: string[]): unknown => {
    const note = () => changed.add(writablePath(path));
    if (typeof value === "string") {
      if (!isRetiredClawboxAiModel(value, refOptions)) return value;
      note();
      return flashRefFor(value);
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      // Flash refs a move produced here: a second copy of one — moved or
      // already there — is dropped, and nothing else is deduplicated.
      const movedTo = new Set<string>();
      value.forEach((item, index) => {
        const next = walk(item, [...path, String(index)]);
        if (typeof next === "string" && next !== item) movedTo.add(next);
        if (typeof next === "string" && movedTo.has(next) && out.includes(next)) return;
        out.push(next);
      });
      return out;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      const out: Record<string, unknown> = {};
      for (const [key, child] of entries) {
        const nextChild = walk(child, [...path, key]);
        if (isRetiredClawboxAiModel(key, refOptions)) {
          note();
          const target = flashRefFor(key);
          if (Object.hasOwn(value as Record<string, unknown>, target) || Object.hasOwn(out, target)) continue;
          out[target] = nextChild;
          continue;
        }
        out[key] = nextChild;
      }
      return out;
    }
    return value;
  };

  const next = walk(agents, []);
  return { agents: next, changedPaths: [...changed].sort() };
}

/**
 * The path a `config set` writes whole for a change at `path` (relative to
 * `agents`): `agents.list` as one array, and two levels into
 * `agents.defaults` — the slot itself (`model`, `imageModel`, `compaction`,
 * `modelPolicy`, `models`, …).
 */
function writablePath(path: string[]): string {
  if (path[0] === "defaults" && path.length >= 2) return `agents.defaults.${path[1]}`;
  return path.length > 0 ? `agents.${path[0]}` : "agents";
}

/* ---------------------------------------------------------------------------
 * Hermes: `model.default` and the auxiliary slots
 * ------------------------------------------------------------------------ */

/** The Hermes config slots ClawBox AI writes a model into, as `[provider key, model key]`. */
export const HERMES_CLAWAI_MODEL_SLOTS = [
  ["model.provider", "model.default"],
  ["auxiliary.vision.provider", "auxiliary.vision.model"],
  ["auxiliary.title_generation.provider", "auxiliary.title_generation.model"],
  ["auxiliary.compression.provider", "auxiliary.compression.model"],
] as const;

/**
 * What a Hermes slot should hold instead, or null to leave it.
 *
 * Moved only when the slot's provider is `clawai` and its model a retired id
 * (bare, the way Hermes stores it). The vision slot takes either kind — a
 * former chat id there is ours just as much — and every other slot only a
 * former chat id: a vision id in a chat slot is nothing ClawBox ever wrote.
 */
export function hermesSlotFlashTarget(
  modelKey: string,
  provider: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if ((provider ?? "").trim().toLowerCase() !== HERMES_CLAWAI_PROVIDER) return null;
  const kind = retiredKind(model, { bare: true });
  if (kind === null) return null;
  if (kind === "vision" && modelKey !== "auxiliary.vision.model") return null;
  return flashRefFor(model as string);
}

/* ---------------------------------------------------------------------------
 * The box's own store: the owner's remembered ClawBox AI pick
 * ------------------------------------------------------------------------ */

/**
 * `ai_model_explicit_picks` with a retired ClawBox AI pick moved to Flash in
 * the spelling it was stored in, or null when nothing in it is retired. Only
 * the `clawai` slot is read: every other provider's pick is that provider's.
 */
export function migrateRetiredClawboxAiPick(picks: unknown): Record<string, string> | null {
  if (!picks || typeof picks !== "object" || Array.isArray(picks)) return null;
  const record = picks as Record<string, unknown>;
  const current = record[HERMES_CLAWAI_PROVIDER];
  if (!isRetiredClawboxAiChatModel(current, { bare: true })) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") out[key] = value;
  }
  out[HERMES_CLAWAI_PROVIDER] = flashRefFor(current as string);
  return out;
}
