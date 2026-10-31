/**
 * Hermes' Tool Search, off while the on-device llama.cpp model is Hermes'
 * default — the Hermes half of src/lib/local-tool-search.ts.
 *
 * WHY. Hermes (v0.22) defers every MCP tool behind `tool_search` /
 * `tool_describe` / `tool_call` while `tools.tool_search` is unset, and its
 * tool-call check refuses a direct call to a deferred tool ("Tool
 * 'mcp__clawbox__webapp_create' does not exist"). Measured on a board: asked in
 * Bulgarian for a todo page, Gemma 4 E2B called `mcp__clawbox__webapp_create`
 * directly with a complete page, was refused, and told the user the page was
 * made. With Tool Search off the same call ran and the app opened.
 *
 * WHY THIS SHAPE. `tools.tool_search` is Hermes' only switch for it and it is
 * global: MCP tools are always eligible for deferral (`is_deferrable_tool_name`,
 * tools/tool_search.py) and no plugin hook can un-defer one. So it follows the
 * default, as OpenClaw's does: off while Hermes' default model is the local
 * llama.cpp one (whose tools the clawbox_local_lean plugin cuts to six), back to
 * Hermes' own default the moment the default is anything else. Measured on the
 * same board, a cloud request with Tool Search off carries 138 tool schemas
 * (152,794 chars) instead of 20 (49,541) — which is why a box whose default is
 * in the cloud keeps it exactly as Hermes ships it. An Ollama-backed local model
 * keeps it too: the lean plugin does not narrow its tools.
 *
 * OWNERSHIP. ClawBox writes the legacy scalar `tools.tool_search: false`
 * (Hermes reads it as off: `ToolSearchConfig.from_raw`) and removes only that
 * exact value. An owner's own block (`hermes config set
 * tools.tool_search.enabled off` writes `{enabled: off}`) or `true` is never
 * touched, so the shape is the mark.
 *
 * Every ClawBox write that can move Hermes' default calls
 * {@link syncHermesToolSearchWithDefault} after it lands; scripts/register-mcp.sh
 * applies the same rule at every web-server start, for a default Hermes itself
 * moved (`/model`, `hermes model`) and for a sync that failed.
 */

import { patchHermesConfig, resolveHermesConfigValue, type HermesConfigRead } from "@/lib/hermes-config-yaml";

/** Hermes' key; keep in step with the Tool Search block in scripts/register-mcp.sh. */
export const HERMES_TOOL_SEARCH_KEY = "tools.tool_search";

/** What ClawBox writes there: the legacy scalar Hermes reads as `enabled: off`. */
export const HERMES_LOCAL_TOOL_SEARCH_OFF = "false";

/**
 * The on-device provider. Mirrors HERMES_LOCAL_PROVIDER in hermes-local-ai.ts,
 * which imports this module and so cannot be imported here.
 */
export const HERMES_LOCAL_TOOL_SEARCH_PROVIDER = "clawlocal";

/** The Local AI proxy path of the llama.cpp backend — the endpoint the lean plugin serves. */
const LLAMACPP_PROXY_PATH = "/setup-api/local-ai/llamacpp/";

/** Whether a default (`model.provider` and the local provider's `base_url`) is the on-device llama.cpp model. */
export function isOnDeviceLlamaCppDefault(provider: string | null, localBaseUrl: string | null): boolean {
  return provider === HERMES_LOCAL_TOOL_SEARCH_PROVIDER && typeof localBaseUrl === "string"
    && localBaseUrl.includes(LLAMACPP_PROXY_PATH);
}

/**
 * The plain scalars PyYAML (what Hermes loads config.yaml with) reads as boolean
 * false — the value register-mcp.sh's boot pass recognises as ClawBox's, so the
 * two halves agree on what is theirs to remove.
 */
const YAML_FALSE = new Set(["false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF"]);

/** ClawBox's value: the scalar `false`, never an owner's `{enabled: …}` block. */
export function isClawboxToolSearchOff(current: HermesConfigRead): boolean {
  return current.state === "value" && YAML_FALSE.has(current.value);
}

/**
 * What makes `tools.tool_search` agree with the default: `"off"` to write
 * ClawBox's value, `"restore"` to take it back out, or null when it already
 * agrees or is not ours to change — an owner's value, or a config that could
 * not be read (absence cannot be proven).
 */
export function hermesToolSearchAction(onDevice: boolean, current: HermesConfigRead): "off" | "restore" | null {
  if (onDevice) return current.state === "absent" ? "off" : null;
  return isClawboxToolSearchOff(current) ? "restore" : null;
}

const valueOf = (read: HermesConfigRead): string | null => (read.state === "value" ? read.value : null);

/**
 * Make Hermes' Tool Search follow its default model, as config.yaml has it now.
 *
 * Never throws: the write that moved the default has already landed, and a
 * failure here leaves Tool Search as it was until the next web-server start,
 * when register-mcp.sh applies the same rule — logged, not hidden.
 */
export async function syncHermesToolSearchWithDefault(label: string): Promise<void> {
  try {
    const [provider, localBaseUrl, current] = await Promise.all([
      resolveHermesConfigValue("model.provider"),
      resolveHermesConfigValue(`providers.${HERMES_LOCAL_TOOL_SEARCH_PROVIDER}.base_url`),
      resolveHermesConfigValue(HERMES_TOOL_SEARCH_KEY),
    ]);
    if (provider.state === "unreadable") return;
    const action = hermesToolSearchAction(isOnDeviceLlamaCppDefault(valueOf(provider), valueOf(localBaseUrl)), current);
    if (action === "off") await patchHermesConfig({ set: { [HERMES_TOOL_SEARCH_KEY]: HERMES_LOCAL_TOOL_SEARCH_OFF } });
    else if (action === "restore") await patchHermesConfig({ unset: [HERMES_TOOL_SEARCH_KEY] });
  } catch (err) {
    console.error(
      `[${label}] could not make Hermes' Tool Search follow the default model; register-mcp.sh repairs it at the next start:`,
      err instanceof Error ? err.message : err,
    );
  }
}
