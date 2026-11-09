/**
 * Does an OpenClaw box have NOTHING to look at an attached picture with — and
 * when it has something, does the chat model see the picture itself or only
 * through a tool?
 *
 * Pure, over openclaw.json as `readConfig` returns it, so the capabilities
 * route can ask it without a probe and a test can ask it without a box. True
 * only when all three hold (TASK-2261):
 *
 *   - the chat runs on ClawBox AI (`deepseek/…` or `clawai/…` primary);
 *   - that model's row does not take pictures (`input` without `image`) — the
 *     vision check writes it text-only when Flash cannot see;
 *   - and no `agents.defaults.imageModel` is set for the `image` tool to use —
 *     the check clears OUR slot when neither Flash nor the fallback can see,
 *     and leaves an owner's own model, which then answers.
 *
 * Any doubt answers false: the attach button OpenClaw always had stays.
 */
import { CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";

interface OpenclawConfigLike {
  agents?: { defaults?: { model?: unknown; imageModel?: unknown } };
  models?: { providers?: Record<string, { models?: unknown } | undefined> };
}

function primaryOf(model: unknown): string {
  if (typeof model === "string") return model.trim();
  if (model && typeof model === "object") {
    const primary = (model as { primary?: unknown }).primary;
    return typeof primary === "string" ? primary.trim() : "";
  }
  return "";
}

function hasModel(slot: unknown): boolean {
  if (typeof slot === "string") return slot.trim().length > 0;
  if (!slot || typeof slot !== "object") return false;
  const { primary, fallbacks } = slot as { primary?: unknown; fallbacks?: unknown };
  if (typeof primary === "string" && primary.trim()) return true;
  return Array.isArray(fallbacks) && fallbacks.some((ref) => typeof ref === "string" && ref.trim());
}

/**
 * How a picture attached to a ClawBox AI chat on OpenClaw gets looked at:
 *
 *   direct    the chat model's row takes `image`: OpenClaw hands it the picture
 *   tool      the chat model is text-only and `agents.defaults.imageModel` is
 *             set: the model must call the `view_image` tool to look at it
 *   none      text-only, and nothing set to look with
 *   other     not a ClawBox AI chat, or not something this can tell
 */
export type OpenclawPictureRoute = "direct" | "tool" | "none" | "other";

export function openclawPictureRoute(config: unknown): OpenclawPictureRoute {
  if (!config || typeof config !== "object") return "other";
  const cfg = config as OpenclawConfigLike;
  const primary = primaryOf(cfg.agents?.defaults?.model);
  const slash = primary.indexOf("/");
  if (slash <= 0) return "other";
  const provider = primary.slice(0, slash).toLowerCase();
  if (provider !== CLAWBOX_AI_PROVIDER && provider !== "clawai") return "other";
  const id = primary.slice(slash + 1);
  const rows = cfg.models?.providers?.[CLAWBOX_AI_PROVIDER]?.models;
  if (!Array.isArray(rows)) return "other";
  const row = rows.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === id) as
    | { input?: unknown }
    | undefined;
  if (!row || !Array.isArray(row.input)) return "other";
  if (row.input.includes("image")) return "direct";
  return hasModel(cfg.agents?.defaults?.imageModel) ? "tool" : "none";
}

export function openclawCannotSeePictures(config: unknown): boolean {
  return openclawPictureRoute(config) === "none";
}
