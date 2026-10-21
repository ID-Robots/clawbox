/**
 * ClawBox AI web search — the box side of it.
 *
 * Max subscribers search the web through the ClawBox AI proxy, which serves a
 * Brave-compatible search route and adds the company's Brave key on the
 * server. The key never reaches the box: OpenClaw's own Brave plugin is pointed
 * at the proxy (`plugins.entries.brave.config.webSearch.baseUrl`, a documented
 * "trusted Brave-compatible proxy" override) and sends the box's own `claw_`
 * token as its key. The plugin appends `/res/v1/web/search` to the base and
 * sends the key as `X-Subscription-Token`, so that is the contract the proxy
 * route answers.
 *
 * The proxy counts and caps searches per account; over the cap, or on a plan
 * without search, it refuses, the plugin reports a provider error, and the
 * agent searches with the browser instead. Nothing on the box hard-fails.
 *
 * OFF BY DEFAULT. `scripts/gateway-pre-start.sh` arms the entry only when the
 * device store carries this flag as a literal `true` and the account's PLAN
 * (`clawai_plan_tier`) is Max. The device badge (`clawai_tier`) is not enough:
 * it is a default a Pro account can carry too. With the flag off, openclaw.json
 * is left exactly as it was.
 *
 * The shell transcribes these values because it cannot import them;
 * src/tests/unit/gateway-pre-start-clawai-search.test.ts pins the two together.
 */

/** Device-store key that turns ClawBox AI web search on. Absent means off. */
export const CLAWAI_WEB_SEARCH_FLAG_KEY = "clawai_web_search";

/** OpenClaw plugin id whose web-search entry the box points at the proxy. */
export const CLAWAI_WEB_SEARCH_PLUGIN_ID = "brave";

/** The package that plugin ships in; installed pinned to the core's release. */
export const CLAWAI_WEB_SEARCH_PLUGIN_PACKAGE = "@openclaw/brave-plugin";

/** Appended to the ClawBox AI proxy base to get the Brave-compatible base. */
export const CLAWAI_WEB_SEARCH_ROUTE = "/search";

/**
 * The plan stamp of the MAX plan. The device names are off by one on purpose
 * (see CLAWBOX_AI_MODEL_BY_TIER in clawbox-ai-models.ts): "pro" is Max.
 */
export const CLAWAI_WEB_SEARCH_PLAN_TIER = "pro";

/** Is the flag on? Only a literal `true` counts; anything else is off. */
export function clawaiWebSearchFlagOn(value: unknown): boolean {
  return value === true;
}

/**
 * The base URL the Brave plugin is given for a ClawBox AI proxy base. One
 * trailing slash on the proxy base is dropped so the route never doubles it.
 */
export function clawaiWebSearchBaseUrl(proxyBaseUrl: string): string {
  const base = proxyBaseUrl.endsWith("/") ? proxyBaseUrl.slice(0, -1) : proxyBaseUrl;
  return base + CLAWAI_WEB_SEARCH_ROUTE;
}

/**
 * Is the Brave plugin on this box ClawBox's to answer for?
 *
 * Only while openclaw.json's `plugins.entries.brave.config.webSearch.apiKey` is
 * a `claw_` token: only ClawBox hands those out, and only the boot script's
 * migration writes one there. The plugin id is not evidence. An owner can
 * install @openclaw/brave-plugin for a Brave key of their own, and consenting
 * to a widened capability surface for it, or reading a refusal that names it
 * as ours, would answer in that owner's place. An entry ClawBox has withdrawn
 * reads as the owner's too, which is the safe direction: with no key, its
 * plugin is dormant.
 *
 * install.sh and scripts/gateway-pre-start.sh ask the same question in shell;
 * src/tests/unit/gateway-pre-start-clawai-search.test.ts pins the three.
 */
export function clawaiWebSearchEntryIsOurs(openclawConfig: unknown): boolean {
  const entries = field(field(openclawConfig, "plugins"), "entries");
  const webSearch = field(field(field(entries, CLAWAI_WEB_SEARCH_PLUGIN_ID), "config"), "webSearch");
  const apiKey = field(webSearch, "apiKey");
  return typeof apiKey === "string" && apiKey.startsWith("claw_");
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
