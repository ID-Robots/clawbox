/**
 * OpenClaw's Tool Search, off while the on-device model is the primary.
 *
 * WHY. OpenClaw (2026.10.x) defers every tool schema but its core file tools
 * behind `tool_search` / `tool_describe` / `tool_call` whenever
 * `tools.toolSearch` is unset. A cloud model handles that; Gemma 4 E2B, the
 * ~2B model llama.cpp serves on the box, does not. Measured on a box: asked for
 * a web app it built the page and then sent `tool_call` with no `id`, twice
 * (once nested, once flat), and claimed success; with direct schemas it called
 * `clawbox__webapp_create` first time and the app opened
 * (reports/clawbox/local-ai/BENCHMARK.md).
 *
 * WHY THIS SHAPE. `tools.toolSearch` is the core's only switch and it is
 * global: there is no per-provider, per-model or per-agent form, and a plugin
 * can only NARROW a turn's tools, never un-defer one. So Tool Search follows
 * the primary: off while the primary is the on-device model (its tools are
 * already cut to six by the clawbox-local-lean plugin), back to OpenClaw's
 * default the moment the primary is a cloud model again. A box whose primary
 * is in the cloud keeps Tool Search exactly as OpenClaw ships it.
 *
 * OWNERSHIP. ClawBox writes `{"enabled": false}` — the object form, which the
 * core reads exactly as `false` — and removes only that exact value. An owner's
 * own `false`, `true` or tuned object is never touched, and the schema has no
 * room for a marker key, so the shape is the mark.
 *
 * Three routes write `agents.defaults.model.primary` from the UI (chat/model,
 * local-ai/exclusive, ai-models/configure); each arms in the batch that writes
 * the primary and disarms after a write that moves it off the device.
 * scripts/gateway-pre-start.sh applies the same rule on every boot, for a box
 * that was already on the local model and for its own migrations.
 */

import { installedOpenclawCoreAtLeast } from "@/lib/openclaw-core-generation";
import { runOpenclawConfigUnset, type OpenClawConfig, type OpenclawConfigSetArgs } from "@/lib/openclaw-config";

export const TOOL_SEARCH_PATH = "tools.toolSearch";

/** What ClawBox writes; keep in step with `_LOCAL_TOOL_SEARCH_OFF` in scripts/gateway-pre-start.sh. */
export const LOCAL_TOOL_SEARCH_OFF: Readonly<{ enabled: false }> = Object.freeze({ enabled: false });

/** A primary on the box's own llama.cpp model — the one the lean plugin serves. */
export function isOnDevicePrimary(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.trim().startsWith("llamacpp/");
}

/** The value ClawBox wrote, exactly: one key, `enabled: false`. */
export function isClawboxToolSearchOff(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "enabled" && (value as { enabled?: unknown }).enabled === false;
}

function toolSearchOf(config: OpenClawConfig | null): unknown {
  const tools: unknown = config?.tools;
  return tools && typeof tools === "object" ? (tools as { toolSearch?: unknown }).toolSearch : undefined;
}

/**
 * The batch entry that turns Tool Search off for a primary on the device — in
 * the SAME batch as the primary, so a refused batch leaves both as they were —
 * or nothing: a cloud primary, an unreadable config (`null`: absence cannot be
 * proven), a value already there (the owner's or ours), or a core older than
 * 2026.10 or one that cannot be read. The key is the core's own, but it rides in
 * the batch that moves the primary, and an older core refusing it would refuse
 * the switch with it; the boot script adds it at the next start once the core
 * is known (gateway-pre-start.sh, CLAWBOX_OPENCLAW_2026_10).
 */
export async function localToolSearchArmOps(
  config: OpenClawConfig | null,
  primary: string | null | undefined,
): Promise<OpenclawConfigSetArgs[]> {
  if (!isOnDevicePrimary(primary) || config === null) return [];
  if (toolSearchOf(config) !== undefined) return [];
  if (!(await installedOpenclawCoreAtLeast(2026, 10))) return [];
  return [[TOOL_SEARCH_PATH, JSON.stringify(LOCAL_TOOL_SEARCH_OFF), "--json"]];
}

/** Whether a write that leaves the primary at `primary` must take ClawBox's value back out. */
export function localToolSearchDisarmNeeded(config: OpenClawConfig | null, primary: string | null | undefined): boolean {
  return !isOnDevicePrimary(primary) && isClawboxToolSearchOff(toolSearchOf(config));
}

/**
 * Take ClawBox's value out, or return the sentence that says it is still in.
 *
 * `config unset`, not a write: a batch has no delete, and the key's absence is
 * what OpenClaw's default means. A failure is reported, not swallowed — the
 * cloud model would run without Tool Search until the next gateway start, which
 * puts it back (gateway-pre-start.sh).
 */
export async function disarmLocalToolSearch(label: string): Promise<string | undefined> {
  try {
    await runOpenclawConfigUnset(TOOL_SEARCH_PATH);
    return undefined;
  } catch (err) {
    console.error(`[${label}] failed to restore OpenClaw's Tool Search default:`, err);
    return "Switched to the cloud model, but OpenClaw's Tool Search is still off (it is off while the on-device "
      + "model is the primary). It comes back on the next gateway restart, or run "
      + `'openclaw config unset ${TOOL_SEARCH_PATH}' from the Terminal.`;
  }
}
